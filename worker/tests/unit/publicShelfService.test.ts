/**
 * Unit tests for `services/publicShelf.ts` — the public-shelf snapshot write
 * shared by the `user` and `publicShelf` route modules.
 *
 * The route-level suites only ever build shelves that are still valid, so the
 * "already expired ⇒ delete instead of put" branch had no coverage anywhere in
 * `worker/tests/`. Testing the service directly also pins the TTL arithmetic,
 * which the HTTP suites cannot observe.
 *
 * Expiry here is decided by the PRODUCTION code's `Date.now()` comparison, not
 * by the KV mock: `createMockKV` only RECORDS `expirationTtl`, it never expires
 * anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writePublicSnapshot } from "../../src/services/publicShelf";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type PublicShelfSnapshot,
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

  // No case in the 1–59s band on purpose: real Cloudflare KV rejects
  // `expirationTtl < 60`, which production does not currently clamp
  // (src/services/publicShelf.ts:19-23). Pinning e.g. `expirationTtl: 59` here
  // would fossilize that broken contract — tracked separately.
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
