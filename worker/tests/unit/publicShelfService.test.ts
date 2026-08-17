/**
 * Unit tests for `services/publicShelf.ts` — the public-shelf snapshot write
 * and the shelf-list resolver, both shared by the `user` and `publicShelf`
 * route modules.
 *
 * The route-level suites only ever build shelves that are still valid, so the
 * "already expired ⇒ delete instead of put" branch had no coverage anywhere in
 * `worker/tests/`. Testing the service directly also pins the TTL arithmetic,
 * which the HTTP suites cannot observe.
 *
 * Expiry here is decided by the PRODUCTION code's `Date.now()` comparison, not
 * by the KV mock: `createMockKV` VALIDATES the 60s floor on `expirationTtl`
 * but never expires anything it accepted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  writePublicSnapshot,
  resolvePublicShelves,
  type PublicShelvesSource,
} from "../../src/services/publicShelf";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type PublicShelfSnapshot,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { ALICE, BOB } from "../helpers/ids";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-01-01T00:00:00.000Z").getTime();

const SHARE_TOKEN = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
const OTHER_SHARE_TOKEN = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
const SNAPSHOT_KEY = kvKeys.publicShelf(SHARE_TOKEN);

let kv: KVNamespace;

function makeShelf(expiresAt: number | null): PublicShelf {
  return {
    shelfId: "shelf-1",
    shareToken: SHARE_TOKEN,
    title: "我的公開書櫃",
    // `writePublicSnapshot` never reads `expiresDays`; kept consistent with
    // `expiresAt` so the fixture does not read as self-contradictory.
    expiresDays:
      expiresAt === null ? null : Math.ceil((expiresAt - NOW) / DAY_MS),
    createdAt: NOW - DAY_MS,
    expiresAt,
    selectionMode: "all-shared",
  };
}

function makeBook(bookId: string, isShared: BoolFlag): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: `Author ${bookId}`,
    isbn: `isbn-${bookId}`,
    coverUrl: `https://cdn.readmoo.com/${bookId}.jpg`,
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "fiction",
    isShared,
  };
}

/** Pre-existing snapshot from an earlier write, owned by someone else. */
async function seedStoredSnapshot(token: string = SHARE_TOKEN): Promise<void> {
  const stale: PublicShelfSnapshot = {
    userId: BOB,
    shelfId: "stale-shelf",
    title: "Stale Shelf",
    books: [makeBook("stale-book", BoolFlag.TRUE)],
    createdAt: NOW - 2 * DAY_MS,
    expiresAt: NOW - DAY_MS,
  };
  await kv.put(kvKeys.publicShelf(token), JSON.stringify(stale));
}

function readSnapshot(
  token: string = SHARE_TOKEN,
): Promise<PublicShelfSnapshot | null> {
  return kv.get<PublicShelfSnapshot>(kvKeys.publicShelf(token), "json");
}

beforeEach(() => {
  kv = createMockKV();
  // Production computes the remaining TTL from `Date.now()`; pin the clock so
  // every TTL assertion is exact. Only Date is faked — nothing schedules a
  // timer here — and `afterEach` restores the real clock either way.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("writePublicSnapshot", () => {
  it("deletes the stored snapshot when the shelf has already expired", async () => {
    await seedStoredSnapshot();

    await writePublicSnapshot(kv, ALICE, makeShelf(NOW - DAY_MS), [
      makeBook("book1", BoolFlag.TRUE),
    ]);

    expect(await readSnapshot()).toBeNull();
    // Nothing was written in place of the deleted entry.
    expect((await kv.list()).keys).toHaveLength(0);
  });

  it.each([
    ["a millisecond in the past", -1],
    ["exactly the current instant", 0],
    ["less than one full second ahead", 999],
    // 1–59s band: real Cloudflare KV rejects `expirationTtl < 60`, so a
    // lifetime shorter than that minimum is deliberately treated as already
    // expired rather than written with a TTL KV would refuse.
    ["one second ahead — below the KV minimum TTL", 1_000],
    ["59 seconds ahead — just below the KV minimum TTL", 59_000],
    ["a millisecond under the 60s KV minimum", 59_999],
  ])(
    "treats an expiry %s as expired and removes the snapshot",
    async (_desc, offsetMs) => {
      await seedStoredSnapshot();

      await writePublicSnapshot(kv, ALICE, makeShelf(NOW + offsetMs), [
        makeBook("book1", BoolFlag.TRUE),
      ]);

      expect(await readSnapshot()).toBeNull();
    },
  );

  it("leaves other shelves' snapshots untouched when deleting an expired one", async () => {
    await seedStoredSnapshot(OTHER_SHARE_TOKEN);

    await writePublicSnapshot(kv, ALICE, makeShelf(NOW - 1), [
      makeBook("book1", BoolFlag.TRUE),
    ]);

    expect(await readSnapshot()).toBeNull();
    expect(await readSnapshot(OTHER_SHARE_TOKEN)).not.toBeNull();
  });

  it("writes the snapshot without an expirationTtl for a permanent shelf", async () => {
    const books = [makeBook("book1", BoolFlag.TRUE)];

    await writePublicSnapshot(kv, ALICE, makeShelf(null), books);

    // `getPutTtl` reports `undefined` for "written without TTL" and for "never
    // written" alike, so pair it with a read proving the snapshot did land.
    const stored = await readSnapshot();
    expect(stored?.userId).toBe(ALICE);
    expect(stored?.expiresAt).toBeNull();
    expect(stored?.books).toEqual(books);
    expect(getPutTtl(kv, SNAPSHOT_KEY)).toBeUndefined();
  });

  // No case in the 1–59s band here by design: Cloudflare KV rejects
  // `expirationTtl < 60`, so production treats such a lifetime as already
  // expired and deletes instead of putting. Those band cases are pinned in the
  // expiry `it.each` above; "one minute ahead" below is the lower valid bound.
  it.each([
    ["seven days ahead", 7 * DAY_MS, 7 * 86_400],
    ["one minute ahead", 60_000, 60],
    ["a fraction over a minute ahead (floored)", 60_500, 60],
  ])(
    "writes the snapshot with the remaining lifetime as expirationTtl (%s)",
    async (_desc, offsetMs, expectedTtl) => {
      await writePublicSnapshot(kv, ALICE, makeShelf(NOW + offsetMs), [
        makeBook("book1", BoolFlag.TRUE),
      ]);

      expect(await readSnapshot()).not.toBeNull();
      expect(getPutTtl(kv, SNAPSHOT_KEY)).toBe(expectedTtl);
    },
  );

  it("stores only the shared books and passes the shelf fields through", async () => {
    const sharedFirst = makeBook("book1", BoolFlag.TRUE);
    const unshared = makeBook("book2", BoolFlag.FALSE);
    const sharedLast = makeBook("book3", BoolFlag.TRUE);
    const shelf = makeShelf(NOW + 30 * DAY_MS);

    await writePublicSnapshot(kv, ALICE, shelf, [
      sharedFirst,
      unshared,
      sharedLast,
    ]);

    expect(await readSnapshot()).toEqual({
      userId: ALICE,
      shelfId: shelf.shelfId,
      title: shelf.title,
      books: [sharedFirst, sharedLast],
      createdAt: shelf.createdAt,
      expiresAt: shelf.expiresAt,
    } satisfies PublicShelfSnapshot);
  });

  it("overwrites a stored snapshot with an empty list when every book is unshared", async () => {
    await seedStoredSnapshot();

    await writePublicSnapshot(kv, ALICE, makeShelf(NOW + DAY_MS), [
      makeBook("book1", BoolFlag.FALSE),
      makeBook("book2", BoolFlag.FALSE),
    ]);

    const stored = await readSnapshot();
    expect(stored?.userId).toBe(ALICE);
    expect(stored?.books).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolvePublicShelves — the lazy-migration fallback rule
// ---------------------------------------------------------------------------
//
// One pure function decides, for EVERY caller (public read path, books
// PUT/PATCH, the four shelf write handlers, account deletion), which shelf list
// is authoritative. Its whole job is the precedence order, so it is pinned here
// rather than only through the HTTP suites — a wrong answer in the empty-pointer
// row is precisely the lost-update bug the pointer key exists to prevent.

/** Shelf as the POINTER key would list it. */
const POINTER_SHELF = makeNamedShelf(
  "shelf-pointer",
  "1111111111111111111111111111111a",
);
/** The same shelf as a STALE legacy field still lists it (pre-rotation token). */
const LEGACY_SHELF = makeNamedShelf(
  "shelf-pointer",
  "2222222222222222222222222222222b",
);

function makeNamedShelf(shelfId: string, shareToken: string): PublicShelf {
  return {
    shelfId,
    shareToken,
    title: "我的公開書櫃",
    expiresDays: null,
    createdAt: NOW - DAY_MS,
    expiresAt: null,
    selectionMode: "all-shared",
  };
}

/** A books record carrying (or not carrying) the legacy `publicSharing` field. */
function legacyRecord(
  shelves?: PublicShelf[],
): Pick<UserBooksRecord, "publicSharing"> {
  return shelves ? { publicSharing: { shelves } } : {};
}

/**
 * A pointer / books record whose `shelves` did NOT survive as an array.
 *
 * Both inputs are `kv.get(..., "json")` casts that nothing validates, so the
 * type has to be forced here to reproduce what corrupted first-hand KV data
 * actually hands the resolver.
 */
function corruptPointer(shelves: unknown): PublicShelvesRecord {
  return { shelves } as unknown as PublicShelvesRecord;
}

function corruptLegacy(
  shelves: unknown,
): Pick<UserBooksRecord, "publicSharing"> {
  return { publicSharing: { shelves } } as unknown as Pick<
    UserBooksRecord,
    "publicSharing"
  >;
}

describe("resolvePublicShelves", () => {
  const CASES: {
    label: string;
    pointer: PublicShelvesRecord | null;
    legacy: Pick<UserBooksRecord, "publicSharing"> | null;
    shelves: PublicShelf[];
    source: PublicShelvesSource;
  }[] = [
    {
      label: "pointer key present and legacy field absent",
      pointer: { shelves: [POINTER_SHELF] },
      legacy: legacyRecord(),
      shelves: [POINTER_SHELF],
      source: "pointer",
    },
    {
      label: "pointer key outranks a stale legacy field listing another token",
      pointer: { shelves: [POINTER_SHELF] },
      legacy: legacyRecord([LEGACY_SHELF]),
      shelves: [POINTER_SHELF],
      source: "pointer",
    },
    {
      // THE row the fix turns on: an empty pointer list means "migrated, all
      // shelves deleted". Falling past it would resurrect a revoked share token.
      label: "an EMPTY pointer list still outranks a populated legacy field",
      pointer: { shelves: [] },
      legacy: legacyRecord([LEGACY_SHELF]),
      shelves: [],
      source: "pointer",
    },
    {
      label: "no pointer key yet — the legacy field is the fallback",
      pointer: null,
      legacy: legacyRecord([LEGACY_SHELF]),
      shelves: [LEGACY_SHELF],
      source: "legacy",
    },
    {
      label: "no pointer key and an emptied legacy list",
      pointer: null,
      legacy: legacyRecord([]),
      shelves: [],
      source: "legacy",
    },
    {
      label: "no pointer key and a record that never had the legacy field",
      pointer: null,
      legacy: legacyRecord(),
      shelves: [],
      source: "none",
    },
    {
      label: "neither key exists — the account has no books record at all",
      pointer: null,
      legacy: null,
      shelves: [],
      source: "none",
    },
  ];

  it.each(CASES)("resolves $label", ({ pointer, legacy, shelves, source }) => {
    expect(resolvePublicShelves(pointer, legacy)).toEqual({ shelves, source });
  });

  /**
   * Every shape a `shelves` field can take once the stored JSON is corrupted or
   * written by an older/foreign writer. The resolver runs on the PUBLIC read
   * path, so each must fail CLOSED (empty list ⇒ the liveness guard answers
   * 404) rather than throw a TypeError that surfaces as a 500 to a stranger.
   */
  const CORRUPT_SHELVES: { label: string; value: unknown }[] = [
    { label: "null", value: null },
    { label: "an absent field", value: undefined },
    { label: "a string", value: "shelf-1" },
    { label: "a number", value: 1 },
    { label: "an object keyed like an array", value: { 0: POINTER_SHELF } },
  ];

  it.each(CORRUPT_SHELVES)(
    "degrades a pointer record whose shelves is $label to an empty POINTER list",
    ({ value }) => {
      // Source stays "pointer" on purpose: falling past a corrupted pointer
      // would resurrect the legacy list — the revoked token this key buries.
      expect(
        resolvePublicShelves(
          corruptPointer(value),
          legacyRecord([LEGACY_SHELF]),
        ),
      ).toEqual({ shelves: [], source: "pointer" });
    },
  );

  it.each(CORRUPT_SHELVES)(
    "resolves no shelves when the legacy field's shelves is $label",
    ({ value }) => {
      expect(resolvePublicShelves(null, corruptLegacy(value))).toEqual({
        shelves: [],
        source: "none",
      });
    },
  );

  it("resolves no shelves when publicSharing itself is not an object", () => {
    const legacy = { publicSharing: "corrupt" } as unknown as Pick<
      UserBooksRecord,
      "publicSharing"
    >;

    expect(resolvePublicShelves(null, legacy)).toEqual({
      shelves: [],
      source: "none",
    });
  });

  it("leaves both inputs untouched", () => {
    // Callers hand it KV records they go on to reuse (the books handlers rebuild
    // `user:{id}` from the same object), so the resolver must not mutate them.
    const pointer: PublicShelvesRecord = { shelves: [POINTER_SHELF] };
    const legacy = legacyRecord([LEGACY_SHELF]);

    resolvePublicShelves(pointer, legacy);

    expect(pointer).toEqual({ shelves: [POINTER_SHELF] });
    expect(legacy).toEqual({ publicSharing: { shelves: [LEGACY_SHELF] } });
  });
});
