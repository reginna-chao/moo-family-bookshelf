import { describe, it, expect } from "vitest";
import { BoolFlag } from "@/api/client";
import { NO_SYNC, lastSyncOf, syncNoticeCountsOf } from "@/dialog/lastSync";

/**
 * `dialog/lastSync.ts`: the last successful sync as useBookSync holds it, and
 * the notice counts the personal shelf reads from it — renamed books (#236)
 * books removed because Readmoo no longer holds them (#241), and books
 * auto-shared or held back by 新書預設開放 (#238). Counts the sync result
 * leaves out default to a value that shows no notice.
 */

const REMOVED_A = "210000000000051";
const REMOVED_B = "210000000000052";

describe("NO_SYNC", () => {
  it("holds no books and every notice count at 0", () => {
    expect(NO_SYNC).toEqual({
      books: [],
      renamedBooks: [],
      renamedBookCount: 0,
      removedBookCount: 0,
      removedSharedCount: 0,
      autoSharedCount: 0,
      autoShareHeldCount: 0,
    });
  });
});

describe("lastSyncOf", () => {
  it("defaults every count to 0 when the result reports neither renames nor removals", () => {
    const sync = lastSyncOf({ success: true, books: [] });

    expect(sync.renamedBooks).toEqual([]);
    expect(sync.renamedBookCount).toBe(0);
    expect(sync.removedBookCount).toBe(0);
    expect(sync.removedSharedCount).toBe(0);
    expect(sync.autoSharedCount).toBe(0);
    expect(sync.autoShareHeldCount).toBe(0);
    expect(sync.lastUpdated).toBeUndefined();
  });

  it("carries the result's removed counts and stamp", () => {
    const sync = lastSyncOf({
      success: true,
      books: [],
      removedBooks: [
        { bookId: REMOVED_A, isShared: BoolFlag.TRUE },
        { bookId: REMOVED_B, isShared: BoolFlag.FALSE },
      ],
      removedBookCount: 2,
      removedSharedCount: 1,
      lastUpdated: "2026-10-01T00:00:00.000Z",
    });

    expect(sync.removedBookCount).toBe(2);
    expect(sync.removedSharedCount).toBe(1);
    expect(sync.lastUpdated).toBe("2026-10-01T00:00:00.000Z");
  });

  it("falls back to the removed list's length when the result carries no count", () => {
    const sync = lastSyncOf({
      success: true,
      books: [],
      removedBooks: [
        { bookId: REMOVED_A, isShared: BoolFlag.FALSE },
        { bookId: REMOVED_B, isShared: BoolFlag.FALSE },
      ],
    });

    expect(sync.removedBookCount).toBe(2);
    expect(sync.removedSharedCount).toBe(0);
  });

  it("prefers the explicit removed count over the list length", () => {
    const sync = lastSyncOf({
      success: true,
      books: [],
      removedBooks: [],
      removedBookCount: 3,
    });

    expect(sync.removedBookCount).toBe(3);
  });

  it("carries the result's auto-share counts", () => {
    const sync = lastSyncOf({
      success: true,
      books: [],
      autoSharedCount: 3,
      autoShareHeldCount: 0,
    });
    expect(sync.autoSharedCount).toBe(3);
    expect(sync.autoShareHeldCount).toBe(0);

    const held = lastSyncOf({
      success: true,
      books: [],
      autoShareHeldCount: 140,
    });
    expect(held.autoSharedCount).toBe(0);
    expect(held.autoShareHeldCount).toBe(140);
  });

  it("falls back to the renamed list's length when the result carries no renamed count", () => {
    const sync = lastSyncOf({
      success: true,
      books: [],
      renamedBooks: [{ oldId: REMOVED_A, newId: REMOVED_B }],
    });

    expect(sync.renamedBookCount).toBe(1);
  });
});

describe("syncNoticeCountsOf", () => {
  it("returns exactly the notice counts of the sync", () => {
    const sync = lastSyncOf({
      success: true,
      books: [],
      renamedBooks: [{ oldId: REMOVED_A, newId: REMOVED_B }],
      renamedBookCount: 1,
      removedBookCount: 4,
      removedSharedCount: 2,
      autoSharedCount: 5,
      autoShareHeldCount: 0,
      lastUpdated: "2026-10-01T00:00:00.000Z",
    });

    expect(syncNoticeCountsOf(sync)).toEqual({
      renamedBookCount: 1,
      removedBookCount: 4,
      removedSharedCount: 2,
      autoSharedCount: 5,
      autoShareHeldCount: 0,
    });
  });

  it("is all zeros for NO_SYNC", () => {
    expect(syncNoticeCountsOf(NO_SYNC)).toEqual({
      renamedBookCount: 0,
      removedBookCount: 0,
      removedSharedCount: 0,
      autoSharedCount: 0,
      autoShareHeldCount: 0,
    });
  });
});
