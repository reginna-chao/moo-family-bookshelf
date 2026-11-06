import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { ALICE } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { writePublicSnapshot } from "../../src/services/publicShelf";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * Reproduction of #468: a write already in flight lands after `DELETE /api/user/:id`
 * has answered 200.
 *
 * THESE CASES PIN TODAY'S BEHAVIOUR OF A KNOWN DEFECT. What they assert is NOT the
 * desired behaviour: an account that was deleted should not get its books or a
 * readable public link back. They exist so the fix for #468 has a failing starting
 * point. When #468 is fixed, invert them; do not read them as a contract.
 *
 * THE CONTROL. `holdNextWrite` stops the first matching write just before it reaches
 * KV. Each case starts the write request, waits until it is parked on that key, runs
 * the whole deletion, proves it answered 200 with the held key absent, and only then
 * releases the write. The request passed auth and did its reads before the deletion
 * began, which is what no check at the route's entry could stop.
 *
 * WHY THE HOLD POINT DIFFERS BY CASE. A public-shelf write puts `publicshelves:` and
 * then `public:{token}`: held at the first put, both land after the deletion, and
 * the read answers 404 only because it also needs the owner's `user:` record (#461);
 * held at the second, only the snapshot lands, and the read guard refuses it because
 * no shelf list names it. `PUT /books` puts `user:` and then the snapshots of the
 * shelves it read, so what the reader gets depends on where that list lives: a
 * migrated owner's new record no longer carries one, an un-migrated owner's does,
 * and that record holds the shared books too, so that link still answers 200.
 *
 * A 404 IS NOT A REPAIR. The list and the snapshot a public-shelf race wrote back
 * stay in KV. The first `user:` write under the same userId makes the link readable
 * again, so the same person coming back and syncing wakes it up; a case pins that.
 *
 * NO SELF-REPAIR. After the race the account has no way to clean up: the bearer is
 * dead, so a retried DELETE stops in the auth middleware. The cases pin that answer
 * too, since it shows the leftovers stay until something else removes them.
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

interface HeldWrite {
  reached: Promise<void>;
  release(): void;
}

/** Park the first `op` on `key`: `reached` resolves when it arrives, `release()` lets it write. */
function holdNextWrite(
  store: KVNamespace,
  op: "put" | "delete",
  key: string,
): HeldWrite {
  let markReached = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = (store[op] as (...args: unknown[]) => Promise<void>).bind(store);
  let held = false;
  vi.spyOn(store, op).mockImplementation((async (...args: unknown[]) => {
    if (args[0] === key && !held) {
      held = true;
      markReached();
      await released;
    }
    return real(...args);
  }) as never);
  return { reached, release };
}

/** Park `write` on `key`, finish the deletion while it waits, then let it land; returns its response. */
async function deleteDuringWrite(
  token: string,
  key: string,
  write: () => Promise<Response>,
): Promise<Response> {
  const hold = holdNextWrite(kv, "put", key);
  const inFlight = write();
  try {
    await hold.reached;
    const deletion = await call("DELETE", `/api/user/${USER}`, token);
    expect(await dataOf(deletion, 200)).toEqual({ ok: true });
    expect(await kv.get(key), "the held write has not landed").toBeNull();
    expect(await kv.get(kvKeys.auth(USER))).toBeNull();
  } finally {
    hold.release();
  }
  return inFlight;
}

/** A family owner with a synced book list and no public shelf yet. */
async function seedOwner(): Promise<string> {
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
  return family.authToken;
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

async function publicRead(shareToken: string): Promise<number> {
  return (await call("GET", `/api/public/${shareToken}`)).status;
}

async function retriedDeleteCode(token: string): Promise<string> {
  const res = await call("DELETE", `/api/user/${USER}`, token);
  expect(res.status).toBe(401);
  return ((await res.json()) as Json).error.code as string;
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a public-shelf update racing DELETE /api/user/:id (#468, current behaviour)", () => {
  it("held at publicshelves: writes the list and snapshot back, and the link answers 404 with no user:", async () => {
    const token = await seedOwner();
    const shelf = await createShelf(token);
    const pointerKey = kvKeys.publicShelves(USER);

    const write = await deleteDuringWrite(token, pointerKey, () =>
      call("PUT", `/api/user/${USER}/public-shelf/${shelf.shelfId}`, token, {
        title: "Renamed",
      }),
    );

    expect(write.status).toBe(200);
    const pointer = (await kv.get(pointerKey, "json")) as Json;
    expect(pointer.shelves.map((s: Json) => s.shareToken)).toEqual([
      shelf.shareToken,
    ]);
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).not.toBeNull();
    expect(await kv.get(kvKeys.user(USER))).toBeNull();
    expect(await publicRead(shelf.shareToken)).toBe(404);
    expect(await retriedDeleteCode(token)).toBe("ACCOUNT_DELETED");
    expect(await publicRead(shelf.shareToken)).toBe(404);
  });

  it("held at publicshelves: leaves a link that wakes up when the same user comes back and syncs", async () => {
    const token = await seedOwner();
    const shelf = await createShelf(token);

    const write = await deleteDuringWrite(
      token,
      kvKeys.publicShelves(USER),
      () =>
        call("PUT", `/api/user/${USER}/public-shelf/${shelf.shelfId}`, token, {
          title: "Renamed",
        }),
    );
    expect(write.status).toBe(200);
    expect(await publicRead(shelf.shareToken)).toBe(404);

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

    expect(await publicRead(shelf.shareToken)).toBe(200);
    expect(await retriedDeleteCode(token)).toBe("UNAUTHORIZED");
  });

  it("held at public:{token} leaves an orphan snapshot the read guard refuses", async () => {
    const token = await seedOwner();
    const shelf = await createShelf(token);
    const snapshotKey = kvKeys.publicShelf(shelf.shareToken);

    const write = await deleteDuringWrite(token, snapshotKey, () =>
      call("PUT", `/api/user/${USER}/public-shelf/${shelf.shelfId}`, token, {
        title: "Renamed",
      }),
    );

    expect(write.status).toBe(200);
    expect(await kv.get(snapshotKey)).not.toBeNull();
    expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    expect(await publicRead(shelf.shareToken)).toBe(404);
    expect(await retriedDeleteCode(token)).toBe("ACCOUNT_DELETED");
  });
});

describe("a public-shelf create racing DELETE /api/user/:id (#468, current behaviour)", () => {
  it("held at publicshelves: writes a new list and snapshot, and the new link answers 404 with no user:", async () => {
    const token = await seedOwner();

    const write = await deleteDuringWrite(
      token,
      kvKeys.publicShelves(USER),
      () =>
        call("POST", `/api/user/${USER}/public-shelf`, token, {
          title: "Shelf",
          expiresDays: null,
        }),
    );

    const { shelf } = await dataOf(write, 201);
    expect(await kv.get(kvKeys.publicShelves(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).not.toBeNull();
    expect(await kv.get(kvKeys.user(USER))).toBeNull();
    expect(await publicRead(shelf.shareToken)).toBe(404);
    expect(await retriedDeleteCode(token)).toBe("ACCOUNT_DELETED");
  });
});

describe("PUT /books racing DELETE /api/user/:id (#468, current behaviour)", () => {
  it("held at user: on a migrated owner brings the books back but not a readable link", async () => {
    const token = await seedOwner();
    const shelf = await createShelf(token);
    const userKey = kvKeys.user(USER);

    const write = await deleteDuringWrite(token, userKey, () =>
      call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] }),
    );

    expect(write.status).toBe(200);
    const record = (await kv.get(userKey, "json")) as UserBooksRecord;
    expect(record.books.map((book) => book.bookId)).toEqual([BOOK.bookId]);
    expect(record.publicSharing).toBeUndefined();
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).not.toBeNull();
    expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    expect(await publicRead(shelf.shareToken)).toBe(404);
    expect(await retriedDeleteCode(token)).toBe("UNAUTHORIZED");
  });

  it("held at user: on an un-migrated owner brings the books and a readable link back", async () => {
    const token = await seedOwner();
    const userKey = kvKeys.user(USER);
    const stored = (await kv.get(userKey, "json")) as UserBooksRecord;
    await kv.put(
      userKey,
      JSON.stringify({ ...stored, publicSharing: { shelves: [LEGACY_SHELF] } }),
    );
    await writePublicSnapshot(kv, USER, LEGACY_SHELF, [BOOK]);
    expect(await publicRead(LEGACY_SHELF.shareToken)).toBe(200);

    const write = await deleteDuringWrite(token, userKey, () =>
      call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] }),
    );

    expect(write.status).toBe(200);
    const record = (await kv.get(userKey, "json")) as UserBooksRecord;
    expect(record.publicSharing?.shelves).toEqual([LEGACY_SHELF]);
    expect(
      await kv.get(kvKeys.publicShelf(LEGACY_SHELF.shareToken)),
    ).not.toBeNull();
    expect(await publicRead(LEGACY_SHELF.shareToken)).toBe(200);
    expect(await retriedDeleteCode(token)).toBe("UNAUTHORIZED");
  });

  it("leaves the deleted bearer dead and marked, so the race is not an undo of the deletion", async () => {
    const token = await seedOwner();
    const mark = kvKeys.accountDeleted(await hashAuthToken(token));

    const write = await deleteDuringWrite(token, kvKeys.user(USER), () =>
      call("PUT", `/api/user/${USER}/books`, token, { books: [BOOK] }),
    );

    expect(write.status).toBe(200);
    expect(await kv.get(mark)).toBe(USER);
    expect(
      await kv.get(kvKeys.authToken(await hashAuthToken(token))),
    ).toBeNull();
    const read = await call("GET", `/api/user/${USER}/books`, token);
    expect(read.status).toBe(401);
    expect(await retriedDeleteCode(token)).toBe("UNAUTHORIZED");
  });
});
