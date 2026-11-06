import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { failFirstWriteTo, holdNextWrite, watchKvOps } from "../helpers/kvOps";
import { passRecreateCooldown } from "../helpers/recreateCooldown";
import { seedAuthToken, tokenOwner } from "../helpers/auth";
import { ALICE, BOB } from "../helpers/ids";
import {
  ACCOUNT_RECREATE_COOLDOWN_MS,
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { MAX_SETTLE_INDEX_HASHES } from "../../src/services/accountDeletion";
import { sweepDeletedAccounts } from "../../src/services/accountDeletionSweep";
import { writePublicSnapshot } from "../../src/services/publicShelf";

/**
 * The cooldown and the mark's last moments on a create or manual join (#468). Everything
 * else about those two routes around a deletion is in `familyAfterAccountDeletion.test.ts`.
 *
 * WHY A COOLDOWN. After a deletion the account has no verification and a userId comes from
 * an email, so a stranger can call `POST /api/family` for it. Before the cooldown that
 * deleted the mark at once, and a write still stuck in flight then landed with nothing left
 * to stop it: the stranger read the owner's unshared books, and an un-migrated owner's old
 * link answered 200 again. "A STUCK WRITE" runs that attack with the real routes. Two
 * minutes is an estimate, not a measurement (`docs/architecture.md` → 已接受的殘餘風險).
 *
 * THE BOUNDARY. A mark younger than `ACCOUNT_RECREATE_COOLDOWN_MS` answers 409 and writes
 * nothing; age equal to it is past it. `Date` is faked (`toFake: ["Date"]`) so an age is exact.
 *
 * ONLY A REAL ADMISSION ENDS A DELETION. `settleDeletionForAdmission` wipes and leaves the
 * mark; the route deletes it past its last refusal and right before its mint. So a kicked
 * tombstone seen by `retractPointerIfKicked` after the wipe, or a family / pointer put that
 * throws, leaves the mark for the sweep and issues no token. The tombstone has to land
 * between the route's first read and the re-check, so `holdNextWrite` parks the pointer or
 * family put and writes it there.
 *
 * A SILENT RECOVERY JOIN never counts as a re-creation, at any age of the mark.
 *
 * `DEV_MODE` is on: rate limits are not under test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const NOW = Date.parse("2026-05-01T12:00:00.000Z");
const USER = ALICE;
const OWNER = BOB;
const MARK_KEY = kvKeys.accountDeleting(USER);
const SHARE_TOKEN = "a1".repeat(16);
const OLD_DEVICE_TOKEN = "d".repeat(64);
const COOLING_AGE = ACCOUNT_RECREATE_COOLDOWN_MS - 1;
const PAST_AGE = ACCOUNT_RECREATE_COOLDOWN_MS + 1;
const IN_PROGRESS_BODY = {
  error: {
    code: "ACCOUNT_DELETION_IN_PROGRESS",
    message: "這個帳戶正在移除，請稍後再試一次",
  },
};
const RECOVERY_REFUSED_BODY = {
  error: { code: "RECOVERY_NOT_MEMBER", message: "你已經不是這個家庭的成員" },
};
const INVALID_TOKEN_BODY = {
  error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
};
const UNSHARED_BOOK: BookEntry = {
  bookId: "210439468000101",
  title: "Private",
  author: "Author",
  isbn: "isbn",
  coverUrl: "https://cdn.readmoo.com/1.jpg",
  readmooUrl: "https://readmoo.com/book/210439468000101",
  category: "fiction",
  isShared: BoolFlag.FALSE,
};
const SHARED_BOOK: BookEntry = {
  ...UNSHARED_BOOK,
  bookId: "210439468000102",
  readmooUrl: "https://readmoo.com/book/210439468000102",
  isShared: BoolFlag.TRUE,
};
const LEGACY_SHELF: PublicShelf = {
  shelfId: "11111111-1111-4111-8111-111111111111",
  shareToken: "c3".repeat(16),
  title: "Legacy shelf",
  expiresDays: null,
  createdAt: 1,
  expiresAt: null,
  selectionMode: "all-shared",
};

let kv: KVNamespace;

function send(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return Promise.resolve(app.request(path, init, { KV: kv, DEV_MODE: "1" }));
}

function createFamily(userId = USER): Promise<Response> {
  return send("POST", "/api/family", { userId });
}

function joinFamily(
  familyId: string,
  extra: object = {},
  userId = USER,
): Promise<Response> {
  return send("POST", `/api/family/${familyId}/join`, { userId, ...extra });
}

async function dataOf(res: Response, status: number): Promise<Json> {
  expect(res.status).toBe(status);
  return ((await res.json()) as Json).data;
}

async function ownerFamily(): Promise<string> {
  const data = await dataOf(await createFamily(OWNER), 201);
  return data.familyId as string;
}

/** Listed with a `member:` naming the family: a join from here takes the reconnect branch. */
async function listedFamily(): Promise<string> {
  const familyId = await ownerFamily();
  await dataOf(await joinFamily(familyId), 200);
  return familyId;
}

async function seedMark(ageMs: number): Promise<void> {
  await kv.put(
    MARK_KEY,
    JSON.stringify({ startedAt: NOW - ageMs, shareTokens: [SHARE_TOKEN] }),
    { expirationTtl: 86400 },
  );
}

/** What a write landing after the deletion left behind, with a device token still alive. */
async function seedLeftovers(): Promise<void> {
  await kv.put(kvKeys.user(USER), JSON.stringify({ userId: USER, books: [] }));
  await kv.put(
    kvKeys.publicShelf(SHARE_TOKEN),
    JSON.stringify({ userId: USER }),
  );
  await seedAuthToken(kv, USER, { token: OLD_DEVICE_TOKEN, appendTo: true });
}

async function expectLeftoversGone(): Promise<void> {
  expect(await kv.get(kvKeys.user(USER))).toBeNull();
  expect(await kv.get(kvKeys.publicShelf(SHARE_TOKEN))).toBeNull();
  expect(await tokenOwner(kv, OLD_DEVICE_TOKEN)).toBeNull();
}

async function expectLeftoversKept(): Promise<void> {
  expect(await kv.get(kvKeys.user(USER))).not.toBeNull();
  expect(await kv.get(kvKeys.publicShelf(SHARE_TOKEN))).not.toBeNull();
  expect(await tokenOwner(kv, OLD_DEVICE_TOKEN)).toBe(USER);
}

/** No session left to use: no `auth:` and no index of a token this request could have minted. */
async function expectNoTokenIssued(): Promise<void> {
  expect(await kv.get(kvKeys.auth(USER))).toBeNull();
  const { keys } = await kv.list({ prefix: kvKeys.authTokenIndex(USER, "") });
  expect(keys).toEqual([]);
}

async function publicRead(shareToken: string): Promise<number> {
  return (await send("GET", `/api/public/${shareToken}`)).status;
}

/** The owner mid-sync: `user:` has books, and a `PUT /books` with the token gets parked on `user:`. */
async function seedOwnerToken(books: BookEntry[]): Promise<string> {
  const family = await dataOf(await createFamily(), 201);
  await dataOf(
    await send("PUT", `/api/user/${USER}/books`, { books }, family.authToken),
    200,
  );
  return family.authToken as string;
}

/** Park a `PUT /books` on `user:` and answer the deletion 200 while it waits. */
async function deleteWhileWriteIsStuck(token: string, books: BookEntry[]) {
  const hold = holdNextWrite(kv, "put", kvKeys.user(USER));
  const stuck = send("PUT", `/api/user/${USER}/books`, { books }, token);
  await hold.reached;
  const deletion = await send("DELETE", `/api/user/${USER}`, undefined, token);
  expect(await dataOf(deletion, 200)).toEqual({ ok: true });
  return { hold, stuck };
}

const ADMISSIONS: {
  label: string;
  status: number;
  seed: () => Promise<string | null>;
  admit: (familyId: string | null) => Promise<Response>;
}[] = [
  {
    label: "POST /api/family",
    status: 201,
    seed: async () => null,
    admit: () => createFamily(),
  },
  {
    label: "a new member's manual join",
    status: 200,
    seed: ownerFamily,
    admit: (familyId) => joinFamily(familyId as string),
  },
  {
    label: "a listed member's manual join",
    status: 200,
    seed: listedFamily,
    admit: (familyId) => joinFamily(familyId as string),
  },
];

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a stranger calling create while a write is stuck", () => {
  it("is refused inside the cooldown, the stuck PUT /books is wiped, and the stranger gains nothing", async () => {
    const token = await seedOwnerToken([UNSHARED_BOOK]);
    const { hold, stuck } = await deleteWhileWriteIsStuck(token, [
      UNSHARED_BOOK,
      SHARED_BOOK,
    ]);
    const mark = await kv.get(MARK_KEY);
    expect(mark).not.toBeNull();

    const stranger = await createFamily();

    expect(stranger.status).toBe(409);
    expect(await stranger.json()).toEqual(IN_PROGRESS_BODY);
    expect(await kv.get(MARK_KEY)).toBe(mark);
    expect(await kv.get(kvKeys.member(USER))).toBeNull();
    await expectNoTokenIssued();

    hold.release();
    const late = await stuck;

    expect(hold.landed()).toBe(true);
    expect(late.status).toBe(401);
    expect(await late.json()).toEqual(INVALID_TOKEN_BODY);
    expect(await kv.get(kvKeys.user(USER))).toBeNull();
    expect(await kv.get(MARK_KEY)).toBe(mark);

    passRecreateCooldown();
    const later = await dataOf(await createFamily(), 201);
    const books = await send(
      "GET",
      `/api/user/${USER}/books`,
      undefined,
      later.authToken,
    );
    expect(await dataOf(books, 200)).toBeNull();
  });

  it("leaves an un-migrated owner's old link 404", async () => {
    const token = await seedOwnerToken([SHARED_BOOK]);
    const userKey = kvKeys.user(USER);
    const stored = (await kv.get(userKey, "json")) as UserBooksRecord;
    await kv.put(
      userKey,
      JSON.stringify({ ...stored, publicSharing: { shelves: [LEGACY_SHELF] } }),
    );
    await writePublicSnapshot(kv, USER, LEGACY_SHELF, stored.books);
    expect(await publicRead(LEGACY_SHELF.shareToken)).toBe(200);
    const { hold, stuck } = await deleteWhileWriteIsStuck(token, stored.books);

    const stranger = await createFamily();

    expect(stranger.status).toBe(409);
    expect(await kv.get(MARK_KEY)).not.toBeNull();

    hold.release();
    const late = await stuck;

    expect(hold.landed()).toBe(true);
    expect(late.status).toBe(401);
    expect(await publicRead(LEGACY_SHELF.shareToken)).toBe(404);

    passRecreateCooldown();
    await dataOf(await createFamily(), 201);
    await sweepDeletedAccounts(kv, Date.now());

    expect(
      await kv.get(kvKeys.publicShelf(LEGACY_SHELF.shareToken)),
    ).toBeNull();
    expect(await publicRead(LEGACY_SHELF.shareToken)).toBe(404);
  });
});

describe.each(ADMISSIONS)(
  "$label and the cooldown",
  ({ status, seed, admit }) => {
    it.each([
      { label: "just written", ageMs: 0 },
      { label: "one millisecond short", ageMs: COOLING_AGE },
    ])(
      "answers 409, wipes nothing and writes nothing when the mark is $label",
      async ({ ageMs }) => {
        const familyId = await seed();
        await seedLeftovers();
        await seedMark(ageMs);
        const mark = await kv.get(MARK_KEY);
        const pointer = await kv.get(kvKeys.member(USER));
        const ops = watchKvOps(kv);

        const res = await admit(familyId);

        expect(res.status).toBe(409);
        expect(await res.json()).toEqual(IN_PROGRESS_BODY);
        expect(ops.writeTrail()).toEqual([]);
        expect(await kv.get(MARK_KEY)).toBe(mark);
        expect(await kv.get(kvKeys.member(USER))).toBe(pointer);
        await expectLeftoversKept();
      },
    );

    it.each([
      {
        label: "exactly the cooldown old",
        ageMs: ACCOUNT_RECREATE_COOLDOWN_MS,
      },
      { label: "one millisecond past it", ageMs: PAST_AGE },
    ])(
      "wipes, ends the deletion and admits when the mark is $label",
      async ({ ageMs }) => {
        const familyId = await seed();
        await seedLeftovers();
        await seedMark(ageMs);

        const data = await dataOf(await admit(familyId), status);

        expect(await kv.get(MARK_KEY)).toBeNull();
        await expectLeftoversGone();
        expect(await tokenOwner(kv, data.authToken)).toBe(USER);
        expect(await kv.get(kvKeys.member(USER))).toBe(data.familyId);
      },
    );

    it.each<{ label: string; mark: Json }>([
      { label: "a word", mark: { startedAt: "soon", shareTokens: [] } },
      { label: "absent", mark: { shareTokens: [] } },
    ])(
      "does not read a startedAt that is $label as cooling, and does not throw",
      async ({ mark }) => {
        const familyId = await seed();
        await kv.put(kvKeys.user(USER), "{}");
        await kv.put(MARK_KEY, JSON.stringify(mark));

        const res = await admit(familyId);

        expect(res.status).toBe(status);
        expect(await kv.get(kvKeys.user(USER))).toBeNull();
        expect(await kv.get(MARK_KEY)).toBeNull();
      },
    );

    it("deletes the mark after the wipe and its own writes, immediately before the mint's first write", async () => {
      const familyId = await seed();
      await seedLeftovers();
      await seedMark(PAST_AGE);
      const ops = watchKvOps(kv);

      await dataOf(await admit(familyId), status);

      const trail = ops.writeTrail();
      const markDelete = trail.indexOf(`delete ${MARK_KEY}`);
      const mintFirstWrite = trail.findIndex((entry) =>
        entry.startsWith(`put ${kvKeys.authTokenIndex(USER, "")}`),
      );
      expect(
        trail.filter((entry) => entry === `delete ${MARK_KEY}`),
      ).toHaveLength(1);
      expect(markDelete).toBeGreaterThan(
        trail.indexOf(`delete ${kvKeys.user(USER)}`),
      );
      expect(markDelete).toBeGreaterThan(
        trail.lastIndexOf(`put ${kvKeys.member(USER)}`),
      );
      expect(
        trail.indexOf(`put ${kvKeys.member(USER)}`),
      ).toBeGreaterThanOrEqual(0);
      expect(mintFirstWrite).toBe(markDelete + 1);
    });
  },
);

describe("a join refused after the wipe, by a tombstone landing behind the first read", () => {
  const CASES: {
    label: string;
    seed: () => Promise<string>;
    holdKey: (familyId: string) => string;
  }[] = [
    {
      label: "a new member, held at the family put",
      seed: ownerFamily,
      holdKey: (familyId) => kvKeys.family(familyId),
    },
    {
      label: "a listed member, held at the pointer heal",
      seed: listedFamily,
      holdKey: () => kvKeys.member(USER),
    },
  ];

  it.each(CASES)(
    "$label answers 403, keeps the mark and issues no token; the sweep still finishes",
    async ({ seed, holdKey }) => {
      const familyId = await seed();
      await seedLeftovers();
      await seedMark(PAST_AGE);
      const mark = await kv.get(MARK_KEY);
      const hold = holdNextWrite(kv, "put", holdKey(familyId));

      const inFlight = joinFamily(familyId);
      await hold.reached;
      await kv.put(
        kvKeys.kicked(familyId, USER),
        JSON.stringify({ removedAt: 1, removedBy: OWNER }),
      );
      hold.release();
      const res = await inFlight;

      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error.code).toBe("MEMBER_REMOVED");
      expect(await kv.get(MARK_KEY)).toBe(mark);
      expect(await kv.get(kvKeys.member(USER))).toBeNull();
      await expectLeftoversGone();
      await expectNoTokenIssued();

      await kv.put(kvKeys.user(USER), "{}");
      await sweepDeletedAccounts(kv, Date.now());
      expect(await kv.get(kvKeys.user(USER))).toBeNull();
    },
  );
});

describe("a write failing between the wipe and the mint", () => {
  const isFamilyKey = (key: string): boolean =>
    key.startsWith(kvKeys.family(""));
  const CASES: {
    label: string;
    status: number;
    seed: () => Promise<string | null>;
    admit: (familyId: string | null) => Promise<Response>;
    failing: (familyId: string | null) => string | ((key: string) => boolean);
  }[] = [
    {
      label: "create's pointer put",
      status: 201,
      seed: async () => null,
      admit: () => createFamily(),
      failing: () => kvKeys.member(USER),
    },
    {
      label: "create's family put",
      status: 201,
      seed: async () => null,
      admit: () => createFamily(),
      failing: () => isFamilyKey,
    },
    {
      label: "a new member's family put",
      status: 200,
      seed: ownerFamily,
      admit: (familyId) => joinFamily(familyId as string),
      failing: (familyId) => kvKeys.family(familyId as string),
    },
    {
      label: "a new member's pointer put",
      status: 200,
      seed: ownerFamily,
      admit: (familyId) => joinFamily(familyId as string),
      failing: () => kvKeys.member(USER),
    },
    {
      label: "a listed member's pointer heal",
      status: 200,
      seed: listedFamily,
      admit: (familyId) => joinFamily(familyId as string),
      failing: () => kvKeys.member(USER),
    },
  ];

  it.each(CASES)(
    "$label answers 500, keeps the mark and issues no token; the retry admits and ends the deletion",
    async ({ status, seed, admit, failing }) => {
      const familyId = await seed();
      await seedLeftovers();
      await seedMark(PAST_AGE);
      const mark = await kv.get(MARK_KEY);
      failFirstWriteTo(kv, "put", failing(familyId));

      const first = await admit(familyId);

      expect(first.status).toBe(500);
      expect(await kv.get(MARK_KEY)).toBe(mark);
      await expectLeftoversGone();
      await expectNoTokenIssued();

      const data = await dataOf(await admit(familyId), status);
      expect(await kv.get(MARK_KEY)).toBeNull();
      expect(await tokenOwner(kv, data.authToken)).toBe(USER);
    },
  );

  it.each(ADMISSIONS)(
    "$label answers 500 and issues no token when the mark itself cannot be deleted",
    async ({ seed, admit }) => {
      const familyId = await seed();
      await seedLeftovers();
      await seedMark(PAST_AGE);
      failFirstWriteTo(kv, "delete", MARK_KEY);

      const first = await admit(familyId);

      expect(first.status).toBe(500);
      expect(await kv.get(MARK_KEY)).not.toBeNull();
      await expectNoTokenIssued();
    },
  );

  it("a create whose mark delete failed recovers through ALREADY_IN_FAMILY and a join", async () => {
    await seedMark(PAST_AGE);
    failFirstWriteTo(kv, "delete", MARK_KEY);
    expect((await createFamily()).status).toBe(500);

    const retry = await createFamily();

    expect(retry.status).toBe(409);
    expect(((await retry.json()) as Json).error.code).toBe("ALREADY_IN_FAMILY");
    expect(await kv.get(MARK_KEY)).not.toBeNull();

    const familyId = (await kv.get(kvKeys.member(USER))) as string;
    const data = await dataOf(await joinFamily(familyId), 200);
    expect(await kv.get(MARK_KEY)).toBeNull();
    expect(await kv.get(kvKeys.member(USER))).toBe(familyId);
    expect(await tokenOwner(kv, data.authToken)).toBe(USER);
  });
});

describe("a create on an account with more tokens than one pass reaches", () => {
  async function seedManyTokens(count: number): Promise<string[]> {
    const hashes = Array.from({ length: count }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    await Promise.all(
      hashes.flatMap((hash) => [
        kv.put(kvKeys.authTokenIndex(USER, hash), "1"),
        kv.put(kvKeys.authToken(hash), "{}"),
      ]),
    );
    await kv.put(kvKeys.auth(USER), JSON.stringify({ tokens: [] }));
    await kv.put(kvKeys.verify(USER), '{"method":"none"}');
    return hashes;
  }

  it("answers 500 with the mark, auth: and verify: kept, and a later pass admits with no old token alive", async () => {
    const hashes = await seedManyTokens(MAX_SETTLE_INDEX_HASHES + 2);
    await seedMark(PAST_AGE);
    const mark = await kv.get(MARK_KEY);

    const first = await createFamily();

    expect(first.status).toBe(500);
    expect(await kv.get(MARK_KEY)).toBe(mark);
    expect(await kv.get(kvKeys.auth(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.verify(USER))).not.toBeNull();
    expect(await kv.get(kvKeys.member(USER))).toBeNull();

    const data = await dataOf(await createFamily(), 201);

    expect(await kv.get(MARK_KEY)).toBeNull();
    expect(await tokenOwner(kv, data.authToken)).toBe(USER);
    for (const hash of hashes) {
      expect(await kv.get(kvKeys.authToken(hash))).toBeNull();
    }
  });
});

describe("a silent recovery join and the mark", () => {
  const AGES = [
    { label: "inside the cooldown", ageMs: COOLING_AGE },
    { label: "past the cooldown", ageMs: PAST_AGE },
  ];

  it.each(AGES)(
    "a listed member's is refused $label, with the mark kept and nothing wiped",
    async ({ ageMs }) => {
      const familyId = await listedFamily();
      await seedLeftovers();
      await seedMark(ageMs);
      const mark = await kv.get(MARK_KEY);
      const pointer = await kv.get(kvKeys.member(USER));
      const ops = watchKvOps(kv);

      const res = await joinFamily(familyId, { recovery: BoolFlag.TRUE });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(RECOVERY_REFUSED_BODY);
      expect(ops.writeTrail()).toEqual([]);
      expect(await kv.get(MARK_KEY)).toBe(mark);
      expect(await kv.get(kvKeys.member(USER))).toBe(pointer);
      await expectLeftoversKept();
    },
  );

  it.each(AGES)(
    "an unlisted user's is refused $label, with the mark kept and nothing wiped",
    async ({ ageMs }) => {
      const familyId = await ownerFamily();
      await seedLeftovers();
      await seedMark(ageMs);
      const mark = await kv.get(MARK_KEY);
      const ops = watchKvOps(kv);

      const res = await joinFamily(familyId, { recovery: BoolFlag.TRUE });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(RECOVERY_REFUSED_BODY);
      expect(ops.writeTrail()).toEqual([]);
      expect(await kv.get(MARK_KEY)).toBe(mark);
      await expectLeftoversKept();
    },
  );
});
