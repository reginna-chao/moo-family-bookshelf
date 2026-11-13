import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { holdNextWrite, watchKvOps } from "../helpers/kvOps";
import { passRecreateCooldown } from "../helpers/recreateCooldown";
import { ALICE } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  TOKEN_RENEW_SKIP_WINDOW_MS,
  type AuthTokenRecord,
  type BookEntry,
  type PublicShelf,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { writePublicSnapshot } from "../../src/services/publicShelf";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * #468: a write already in flight lands after `DELETE /api/user/:id` has answered 200,
 * and must not bring the account's data or a readable public link back.
 *
 * THE CONTROL. `holdNextWrite` stops the first matching write just before it reaches
 * KV. Each case starts the write request, waits until it is parked on that key, runs
 * the whole deletion, proves it answered 200 with the held key absent, and only then
 * releases the write. The request passed auth and did its reads before the deletion
 * began, which is what no check at the route's entry could stop; a held write that was
 * never reached fails the case at once, so a reordered handler cannot pass vacuously.
 *
 * WHAT EVERY CASE ASSERTS (`expectAccountGone`). The held write landed; `accountDeletionGuard`
 * answers it 401 byte-identical to an invalid token; `user:`, `publicshelves:` and every
 * `public:{token}` the race knew are gone; each link answers 404; no `token:` or
 * `tokenidx:` key is alive; a retried DELETE answers `ACCOUNT_DELETED`; a re-create inside
 * the cooldown answers 409 and keeps the mark; and the same person re-creating past it and
 * syncing leaves the old links 404, with the mark gone.
 *
 * WHY THE HOLD POINT DIFFERS BY CASE. Each write is held at each key whose landing leaves
 * a different state. Public-shelf create and reset-token write the snapshot and then the
 * list: held at the snapshot both land after the deletion, held at the list only the
 * list does, and it names a token the deletion never saw. Update writes the list then the
 * snapshot. `PUT` / `PATCH /books` write `user:` and then the snapshots of the shelves
 * they read, so an un-migrated owner's held write puts back a record that carries the list.
 *
 * WHAT THIS DOES NOT PROVE. `createMockKV()` is one instantly consistent store with no
 * one-write-per-second limit, so here the guard always sees the mark and always manages
 * the delete. On real KV either can miss, which is why the guarantee is the sweep
 * (`accountDeletionSweep.test.ts`), not this path: docs/architecture.md → 家庭成員的授權與移除.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER = ALICE;
const BOOK: BookEntry = {
  bookId: "210439468000101",
  title: "Book",
  author: "Author",
  isbn: "isbn",
  coverUrl: "https://cdn.readmoo.com/1.jpg",
  readmooUrl: "https://readmoo.com/book/210439468000101",
  category: "fiction",
  isShared: BoolFlag.TRUE,
};
const LEGACY_SHELF: PublicShelf = {
  shelfId: "11111111-1111-4111-8111-111111111111",
  shareToken: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  title: "Legacy shelf",
  expiresDays: null,
  createdAt: 1,
  expiresAt: null,
  selectionMode: "all-shared",
};
const INVALID_TOKEN_BODY = {
  error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
};
const SNAPSHOT_PREFIX = kvKeys.publicShelf("");

type KeyMatch = string | ((key: string) => boolean);

let kv: KVNamespace;

function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return Promise.resolve(app.request(path, init, { KV: kv, DEV_MODE: "1" }));
}

async function dataOf(res: Response, status: number): Promise<Json> {
  expect(res.status).toBe(status);
  return ((await res.json()) as Json).data;
}

interface RaceResult {
  write: Response;
  /** Every `public:{token}` the racing write put, including one with a token only it knows. */
  shareTokensWritten: string[];
}

/** Park `write` on `key`, finish the deletion while it waits, then let it land. */
async function deleteDuringWrite(
  token: string,
  key: KeyMatch,
  write: () => Promise<Response>,
): Promise<RaceResult> {
  const hold = holdNextWrite(kv, "put", key);
  const ops = watchKvOps(kv);
  const inFlight = write();
  try {
    await Promise.race([
      hold.reached,
      inFlight.then(async (res) => {
        throw new Error(
          `the write answered ${res.status} without reaching the hold`,
        );
      }),
    ]);
    const deletion = await call("DELETE", `/api/user/${USER}`, token);
    expect(await dataOf(deletion, 200)).toEqual({ ok: true });
    const heldKey = hold.heldKey() as string;
    expect(await kv.get(heldKey), "the held write has not landed").toBeNull();
    expect(await kv.get(kvKeys.auth(USER))).toBeNull();
    expect(hold.landed()).toBe(false);
  } finally {
    hold.release();
  }
  const res = await inFlight;
  expect(hold.landed(), "the held write landed after the deletion").toBe(true);
  return {
    write: res,
    shareTokensWritten: ops
      .putKeys()
      .filter((name) => name.startsWith(SNAPSHOT_PREFIX))
      .map((name) => name.slice(SNAPSHOT_PREFIX.length)),
  };
}

interface Owner {
  token: string;
  familyId: string;
}

/** A family owner with a synced book list and no public shelf yet. */
async function seedOwner(): Promise<Owner> {
  const family = await dataOf(
    await call("POST", "/api/family", undefined, { userId: USER }),
    201,
  );
  await dataOf(
    await call("PUT", `/api/user/${USER}/books`, family.authToken, {
      books: [BOOK],
    }),
    200,
  );
  return { token: family.authToken, familyId: family.familyId };
}

async function createShelf(token: string): Promise<PublicShelf> {
  const { shelf } = await dataOf(
    await call("POST", `/api/user/${USER}/public-shelf`, token, {
      title: "Shelf",
      expiresDays: null,
    }),
    201,
  );
  return shelf;
}

/** A migrated owner with a live public link, which must be readable before the race starts. */
async function seedOwnerWithShelf(): Promise<Owner & { shelf: PublicShelf }> {
  const owner = await seedOwner();
  const shelf = await createShelf(owner.token);
  expect(await publicRead(shelf.shareToken)).toBe(200);
  return { ...owner, shelf };
}

/** An owner whose shelf list still lives in `user:{id}.publicSharing`, with its snapshot live. */
async function seedUnmigratedOwner(): Promise<Owner> {
  const owner = await seedOwner();
  const userKey = kvKeys.user(USER);
  const stored = (await kv.get(userKey, "json")) as UserBooksRecord;
  await kv.put(
    userKey,
    JSON.stringify({ ...stored, publicSharing: { shelves: [LEGACY_SHELF] } }),
  );
  await writePublicSnapshot(kv, USER, LEGACY_SHELF, [BOOK]);
  expect(await publicRead(LEGACY_SHELF.shareToken)).toBe(200);
  return owner;
}

async function publicRead(shareToken: string): Promise<number> {
  return (await call("GET", `/api/public/${shareToken}`)).status;
}

async function retriedDeleteCode(token: string): Promise<string> {
  const res = await call("DELETE", `/api/user/${USER}`, token);
  expect(res.status).toBe(401);
  return ((await res.json()) as Json).error.code as string;
}

async function keysUnder(prefix: string): Promise<string[]> {
  const { keys } = await kv.list({ prefix });
  return keys.map((key) => key.name);
}

/** `token:{hash}` keys only: the two marks share the prefix and are meant to stay. */
async function liveTokenKeys(): Promise<string[]> {
  return (await keysUnder("token:")).filter(
    (name) =>
      !name.startsWith(kvKeys.accountDeleted("")) &&
      !name.startsWith(kvKeys.accountDeleting("")),
  );
}

/** See the header → "WHAT EVERY CASE ASSERTS". `shareTokens` are the links known before the race. */
async function expectAccountGone(
  token: string,
  race: RaceResult,
  shareTokens: string[],
): Promise<void> {
  expect(race.write.status).toBe(401);
  expect(await race.write.json()).toEqual(INVALID_TOKEN_BODY);

  for (const key of [
    kvKeys.user(USER),
    kvKeys.publicShelves(USER),
    kvKeys.newBookDefault(USER),
    kvKeys.accountSettings(USER),
    kvKeys.otp(USER),
    kvKeys.member(USER),
    kvKeys.auth(USER),
    kvKeys.verify(USER),
  ]) {
    expect(await kv.get(key), key).toBeNull();
  }
  const links = [...new Set([...shareTokens, ...race.shareTokensWritten])];
  for (const shareToken of links) {
    expect(await kv.get(kvKeys.publicShelf(shareToken))).toBeNull();
    expect(await publicRead(shareToken)).toBe(404);
  }
  expect(await keysUnder(SNAPSHOT_PREFIX)).toEqual([]);
  expect(await liveTokenKeys()).toEqual([]);
  expect(await keysUnder(kvKeys.authTokenIndex(USER, ""))).toEqual([]);
  expect(await kv.get(kvKeys.accountDeleting(USER))).not.toBeNull();
  expect(await retriedDeleteCode(token)).toBe("ACCOUNT_DELETED");

  const cooling = await call("POST", "/api/family", undefined, {
    userId: USER,
  });
  expect(cooling.status).toBe(409);
  expect(await kv.get(kvKeys.accountDeleting(USER))).not.toBeNull();

  passRecreateCooldown();
  const family = await dataOf(
    await call("POST", "/api/family", undefined, { userId: USER }),
    201,
  );
  await dataOf(
    await call("PUT", `/api/user/${USER}/books`, family.authToken, {
      books: [BOOK],
    }),
    200,
  );
  expect(await kv.get(kvKeys.accountDeleting(USER))).toBeNull();
  expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
  for (const shareToken of links) {
    expect(await publicRead(shareToken)).toBe(404);
  }
}

const isSnapshot = (key: string): boolean => key.startsWith(SNAPSHOT_PREFIX);

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a public-shelf create racing DELETE /api/user/:id", () => {
  it.each<{ label: string; holdAt: KeyMatch }>([
    { label: "the new snapshot", holdAt: isSnapshot },
    { label: "publicshelves:", holdAt: kvKeys.publicShelves(USER) },
  ])("held at $label leaves nothing behind", async ({ holdAt }) => {
    const { token } = await seedOwner();

    const race = await deleteDuringWrite(token, holdAt, () =>
      call("POST", `/api/user/${USER}/public-shelf`, token, {
        title: "Shelf",
        expiresDays: null,
      }),
    );

    expect(race.shareTokensWritten).toHaveLength(1);
    await expectAccountGone(token, race, []);
  });
});

describe("a public-shelf update racing DELETE /api/user/:id", () => {
  it.each<{ label: string; holdAt: (shelf: PublicShelf) => KeyMatch }>([
    { label: "publicshelves:", holdAt: () => kvKeys.publicShelves(USER) },
    {
      label: "public:{token}",
      holdAt: (shelf) => kvKeys.publicShelf(shelf.shareToken),
    },
  ])("held at $label leaves nothing behind", async ({ holdAt }) => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(token, holdAt(shelf), () =>
      call("PUT", `/api/user/${USER}/public-shelf/${shelf.shelfId}`, token, {
        title: "Renamed",
      }),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });
});

describe("a public-shelf reset-token racing DELETE /api/user/:id", () => {
  it.each<{ label: string; holdAt: KeyMatch }>([
    { label: "the new snapshot", holdAt: isSnapshot },
    { label: "publicshelves:", holdAt: kvKeys.publicShelves(USER) },
  ])(
    "held at $label kills the old and the new link alike",
    async ({ holdAt }) => {
      const { token, shelf } = await seedOwnerWithShelf();

      const race = await deleteDuringWrite(token, holdAt, () =>
        call(
          "POST",
          `/api/user/${USER}/public-shelf/${shelf.shelfId}/reset-token`,
          token,
        ),
      );

      expect(race.shareTokensWritten).toHaveLength(1);
      expect(race.shareTokensWritten[0]).not.toBe(shelf.shareToken);
      await expectAccountGone(token, race, [shelf.shareToken]);
    },
  );
});

describe("a public-shelf delete racing DELETE /api/user/:id", () => {
  it("held at publicshelves: does not put an empty list back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(
      token,
      kvKeys.publicShelves(USER),
      () =>
        call(
          "DELETE",
          `/api/user/${USER}/public-shelf/${shelf.shelfId}`,
          token,
        ),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });
});

const BOOK_WRITES: {
  label: string;
  send: (token: string) => Promise<Response>;
}[] = [
  {
    label: "PUT /books",
    send: (token) =>
      call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] }),
  },
  {
    label: "PATCH /books",
    send: (token) =>
      call("PATCH", `/api/user/${USER}/books`, token, {
        changes: [{ bookId: BOOK.bookId, isShared: BoolFlag.TRUE }],
      }),
  },
];

describe.each(BOOK_WRITES)("$label racing DELETE /api/user/:id", ({ send }) => {
  it("held at user: on a migrated owner brings neither the books nor a link back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(token, kvKeys.user(USER), () =>
      send(token),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("held at public:{token} on a migrated owner does not put the snapshot back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(
      token,
      kvKeys.publicShelf(shelf.shareToken),
      () => send(token),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("held at user: on an un-migrated owner does not bring the record carrying the list back", async () => {
    const { token } = await seedUnmigratedOwner();

    const race = await deleteDuringWrite(token, kvKeys.user(USER), () =>
      send(token),
    );

    await expectAccountGone(token, race, [LEGACY_SHELF.shareToken]);
  });

  it("held at public:{token} on an un-migrated owner does not put the snapshot back", async () => {
    const { token } = await seedUnmigratedOwner();

    const race = await deleteDuringWrite(
      token,
      kvKeys.publicShelf(LEGACY_SHELF.shareToken),
      () => send(token),
    );

    await expectAccountGone(token, race, [LEGACY_SHELF.shareToken]);
  });
});

describe("personal-setting writes racing DELETE /api/user/:id", () => {
  it("PUT /family-prefs held at user: does not bring the books back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(token, kvKeys.user(USER), () =>
      call("PUT", `/api/user/${USER}/family-prefs`, token, { hidden: [] }),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("PUT /new-book-default held at newbookdefault: does not bring the setting back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(
      token,
      kvKeys.newBookDefault(USER),
      () =>
        call("PUT", `/api/user/${USER}/new-book-default`, token, {
          newBookDefaultShared: BoolFlag.TRUE,
        }),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("PATCH /settings held at settings: does not bring the settings back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(
      token,
      kvKeys.accountSettings(USER),
      () =>
        call("PATCH", `/api/user/${USER}/settings`, token, {
          settings: { syncArchived: BoolFlag.TRUE },
        }),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it.each([
    { label: "user:", key: () => kvKeys.user(USER) },
    {
      label: "family:{id}",
      key: (familyId: string) => kvKeys.family(familyId),
    },
  ])(
    "PUT .../displayName held at $label does not bring the books back",
    async ({ key }) => {
      const { token, familyId, shelf } = await seedOwnerWithShelf();

      const race = await deleteDuringWrite(token, key(familyId), () =>
        call(
          "PUT",
          `/api/family/${familyId}/member/${USER}/displayName`,
          token,
          { displayName: "Renamed" },
        ),
      );

      await expectAccountGone(token, race, [shelf.shareToken]);
    },
  );
});

describe("verification writes racing DELETE /api/user/:id", () => {
  it("PUT /verify (none) held at verify: does not bring the record back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(token, kvKeys.verify(USER), () =>
      call("PUT", `/api/user/${USER}/verify`, token, { method: "none" }),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("a PIN save held at verify: revokes its own token and mints, and the guard still removes all of it", async () => {
    const { token, shelf } = await seedOwnerWithShelf();
    const ops = watchKvOps(kv);

    const race = await deleteDuringWrite(token, kvKeys.verify(USER), () =>
      call("PUT", `/api/user/${USER}/verify`, token, {
        method: "pin",
        secret: "123456",
      }),
    );

    // Positive companion for "no token alive": the only `auth:` put in this request is the new mint.
    expect(ops.putKeys()).toContain(kvKeys.auth(USER));
    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("POST /verify/prompted held at verify: does not bring the record back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(token, kvKeys.verify(USER), () =>
      call("POST", `/api/user/${USER}/verify/prompted`, token),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("POST /verify/otp held at otp: does not bring the code back", async () => {
    const { token, shelf } = await seedOwnerWithShelf();
    await dataOf(
      await call("PUT", `/api/user/${USER}/verify`, token, { method: "code" }),
      200,
    );

    const race = await deleteDuringWrite(token, kvKeys.otp(USER), () =>
      call("POST", `/api/user/${USER}/verify/otp`, token),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });

  it("POST /qr-token held at qr: answers 401, and the token it would bind to is gone", async () => {
    const { token, shelf } = await seedOwnerWithShelf();

    const race = await deleteDuringWrite(
      token,
      (key) => key.startsWith("qr:"),
      () => call("POST", `/api/user/${USER}/qr-token`, token),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });
});

describe("POST /api/auth/refresh racing DELETE /api/user/:id", () => {
  /** Age the token past the skip window, so that a refresh really rewrites its keys. */
  async function ageToken(token: string): Promise<string> {
    const hash = await hashAuthToken(token);
    const key = kvKeys.authToken(hash);
    const stored = (await kv.get(key, "json")) as AuthTokenRecord;
    await kv.put(
      key,
      JSON.stringify({
        ...stored,
        expiresAt: stored.expiresAt - TOKEN_RENEW_SKIP_WINDOW_MS * 2,
      }),
    );
    return hash;
  }

  it.each([
    {
      label: "tokenidx:",
      key: (hash: string) => kvKeys.authTokenIndex(USER, hash),
    },
    { label: "token:", key: (hash: string) => kvKeys.authToken(hash) },
  ])(
    "a slide held at $label does not bring the token back",
    async ({ key }) => {
      const { token, shelf } = await seedOwnerWithShelf();
      const hash = await ageToken(token);

      const race = await deleteDuringWrite(token, key(hash), () =>
        call("POST", "/api/auth/refresh", token, { userId: USER }),
      );

      await expectAccountGone(token, race, [shelf.shareToken]);
    },
  );

  it("a TTL-gap mint held at its first key does not leave a new token alive", async () => {
    const { token, shelf } = await seedOwnerWithShelf();
    await kv.delete(kvKeys.auth(USER));

    const race = await deleteDuringWrite(
      token,
      (key) => key.startsWith(kvKeys.authTokenIndex(USER, "")),
      () => call("POST", "/api/auth/refresh", token, { userId: USER }),
    );

    await expectAccountGone(token, race, [shelf.shareToken]);
  });
});

describe("the deleted bearer after a race", () => {
  it("stays dead and marked, so the race is not an undo of the deletion", async () => {
    const { token } = await seedOwner();
    const mark = kvKeys.accountDeleted(await hashAuthToken(token));

    const race = await deleteDuringWrite(token, kvKeys.user(USER), () =>
      call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] }),
    );

    expect(race.write.status).toBe(401);
    expect(await kv.get(mark)).toBe(USER);
    expect(
      await kv.get(kvKeys.authToken(await hashAuthToken(token))),
    ).toBeNull();
    const read = await call("GET", `/api/user/${USER}/books`, token);
    expect(read.status).toBe(401);
    expect(await retriedDeleteCode(token)).toBe("ACCOUNT_DELETED");
  });
});
