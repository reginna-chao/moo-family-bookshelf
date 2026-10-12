import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PRUNE_MAX_PER_SYNC,
  PRUNE_MAX_RATIO,
  PRUNE_MIN_ALLOWANCE,
  pruneRemovedBooks,
  type PruneContext,
} from "@/sync/pruneBooks";
import { BoolFlag, type BookEntry } from "@/api/client";

/**
 * Pruning (#241, `sync/pruneBooks.ts`): a saved real-id book is removed only
 * when nothing explains its absence — it is on the server, this scrape did not
 * find it, Readmoo's own library lists (owned, archived, lent-out, borrowed-in,
 * published by the fiber bridge as `libraryIds`) do not hold it, and it is not
 * lent out through MooFamily. The library lists are a KEEP-set: a book Readmoo
 * still holds but the scrape cannot see (loaned out on Readmoo, archived while
 * archive sync is off) must survive. A saved entry marked archived is never a
 * candidate while archive sync is off: the archive was not read at all.
 *
 * Safety gates, each a no-op that returns the input array itself:
 * - `libraryIds` null (the bridge could not read the host);
 * - an empty scrape (looks exactly like a library still loading), silently;
 * - `libraryIds` not covering every scraped id (the two reads disagree about the
 *   account), with a count-only warning;
 * - more candidates than `min(PRUNE_MAX_PER_SYNC, max(PRUNE_MIN_ALLOWANCE,
 *   floor(realTotal * PRUNE_MAX_RATIO)))`, where `realTotal` counts real-id
 *   entries only, with a count-only warning.
 * Legacy short-id entries (#234) are never candidates and never counted.
 */

const A = "210000000000061";
const B = "210000000000062";
const C = "210000000000063";
const D = "210000000000064";
const LEGACY = "1234567";

const COVER_WARNING =
  "[moo] prune skipped: fiber library ids do not cover the scrape";
const CAP_WARNING = "[moo] prune skipped: too many books would be removed";

function book(bookId: string, isShared = BoolFlag.FALSE): BookEntry {
  return {
    bookId,
    title: `書 ${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared,
    isArchived: BoolFlag.FALSE,
  };
}

/** Every entry of `books` is on the server unless `serverIds` says otherwise. */
function ctxFor(
  books: BookEntry[],
  overrides: Partial<PruneContext> = {},
): PruneContext {
  return {
    scrapedIds: new Set(),
    libraryIds: new Set(),
    lentBookIds: new Set(),
    serverIds: new Set(books.map((b) => b.bookId)),
    syncArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

/** `count` distinct real ids starting at suffix `from`. */
function realIds(count: number, from = 100): string[] {
  return Array.from(
    { length: count },
    (_, i) => `2100000${String(from + i).padStart(8, "0")}`,
  );
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("pruneRemovedBooks", () => {
  it("pins the cap constants", () => {
    expect(PRUNE_MAX_RATIO).toBe(0.25);
    expect(PRUNE_MIN_ALLOWANCE).toBe(2);
    expect(PRUNE_MAX_PER_SYNC).toBe(20);
  });

  it("removes only the book neither the scrape nor Readmoo's library lists hold (#241)", () => {
    // A is on the shelf; B is loaned out on Readmoo and C archived — both seen
    // only in the library lists; D is gone from Readmoo entirely.
    const books = [book(A), book(B), book(C), book(D)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, {
        scrapedIds: new Set([A]),
        libraryIds: new Set([A, B, C]),
      }),
    );

    expect(result.books.map((b) => b.bookId)).toEqual([A, B, C]);
    expect(result.removedBooks).toEqual([
      { bookId: D, isShared: BoolFlag.FALSE },
    ]);
    expect(result.removedCount).toBe(1);
    expect(result.removedSharedCount).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns the input array itself and removes nothing when the library ids are unknown", () => {
    const books = [book(A), book(D)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, { scrapedIds: new Set([A]), libraryIds: null }),
    );

    expect(result).toEqual({
      books,
      removedBooks: [],
      removedCount: 0,
      removedSharedCount: 0,
    });
    expect(result.books).toBe(books);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips with a count-only warning when the library ids miss a scraped id", () => {
    const books = [book(A), book(B), book(D)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, {
        scrapedIds: new Set([A, B]),
        libraryIds: new Set([A]),
      }),
    );

    expect(result.books).toBe(books);
    expect(result.removedCount).toBe(0);
    expect(result.removedBooks).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(COVER_WARNING, {
      scraped: 2,
      covered: 1,
    });
    // Count only: no ids in the log.
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain(B);
  });

  it("keeps a book lent out through MooFamily even though Readmoo no longer lists it", () => {
    const books = [book(A), book(D)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, {
        scrapedIds: new Set([A]),
        libraryIds: new Set([A]),
        lentBookIds: new Set([D]),
      }),
    );

    expect(result.books).toBe(books);
    expect(result.removedCount).toBe(0);
  });

  it("keeps an entry the server does not hold", () => {
    const books = [book(A), book(D)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, {
        scrapedIds: new Set([A]),
        libraryIds: new Set([A]),
        serverIds: new Set([A]),
      }),
    );

    expect(result.books).toBe(books);
    expect(result.removedCount).toBe(0);
  });

  it("never treats a legacy short-id entry as a candidate", () => {
    const books = [book(A), book(LEGACY, BoolFlag.TRUE)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, { scrapedIds: new Set([A]), libraryIds: new Set([A]) }),
    );

    expect(result.books).toBe(books);
    expect(result.removedCount).toBe(0);
  });

  it("leaves legacy short-id entries out of the cap's total", () => {
    // 8 real + 8 legacy: counting legacy would allow 4 removals, real-only allows 2.
    const real = realIds(8).map((id) => book(id));
    const legacy = Array.from({ length: 8 }, (_, i) => book(`12345${i}`));
    const books = [...real, ...legacy];
    const kept = real.slice(0, 5).map((b) => b.bookId);

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, {
        scrapedIds: new Set(kept),
        libraryIds: new Set(kept),
      }),
    );

    expect(result.books).toBe(books);
    expect(warnSpy).toHaveBeenCalledWith(CAP_WARNING, {
      candidates: 3,
      realTotal: 8,
      allowed: 2,
    });
  });

  describe("the per-sync cap", () => {
    it.each([
      { realTotal: 10, candidates: 2, allowed: 2, removed: true },
      { realTotal: 10, candidates: 3, allowed: 2, removed: false },
      { realTotal: 12, candidates: 3, allowed: 3, removed: true },
      { realTotal: 12, candidates: 4, allowed: 3, removed: false },
      // floor(3 * 0.25) = 0 — the minimum allowance still lets a small library shrink.
      { realTotal: 3, candidates: 2, allowed: 2, removed: true },
      { realTotal: 4, candidates: 3, allowed: 2, removed: false },
      // The absolute ceiling: floor(100 * 0.25) = 25 and floor(1000 * 0.25) = 250, capped at 20.
      { realTotal: 100, candidates: 20, allowed: 20, removed: true },
      { realTotal: 100, candidates: 21, allowed: 20, removed: false },
      { realTotal: 1000, candidates: 21, allowed: 20, removed: false },
    ])(
      "$realTotal real books, $candidates candidates (allowed $allowed) → removed=$removed",
      ({ realTotal, candidates, allowed, removed }) => {
        const books = realIds(realTotal).map((id) => book(id));
        const kept = books.slice(candidates).map((b) => b.bookId);

        const result = pruneRemovedBooks(
          books,
          ctxFor(books, {
            scrapedIds: new Set(kept),
            libraryIds: new Set(kept),
          }),
        );

        if (removed) {
          expect(result.removedCount).toBe(candidates);
          expect(result.books.map((b) => b.bookId)).toEqual(kept);
          expect(warnSpy).not.toHaveBeenCalled();
        } else {
          expect(result.books).toBe(books);
          expect(result.removedCount).toBe(0);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(CAP_WARNING, {
            candidates,
            realTotal,
            allowed,
          });
        }
      },
    );

    it("does not wipe a large saved list when Readmoo reports an empty library", () => {
      const books = realIds(10).map((id) => book(id));

      const result = pruneRemovedBooks(
        books,
        ctxFor(books, { scrapedIds: new Set(), libraryIds: new Set() }),
      );

      expect(result.books).toBe(books);
      expect(result.removedCount).toBe(0);
      // Stopped by the empty-scrape gate, before the cap is ever evaluated.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not wipe a large saved list when Readmoo reports a near-empty library", () => {
      const books = realIds(10).map((id) => book(id));
      const only = new Set([books[0].bookId]);

      const result = pruneRemovedBooks(
        books,
        ctxFor(books, { scrapedIds: only, libraryIds: only }),
      );

      expect(result.books).toBe(books);
      expect(result.removedCount).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(CAP_WARNING, {
        candidates: 9,
        realTotal: 10,
        allowed: 2,
      });
    });
  });

  it("prunes nothing and stays silent when the scrape is empty, even if the library ids miss saved books", () => {
    const books = [book(A), book(B), book(C), book(D)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, { scrapedIds: new Set(), libraryIds: new Set([A, B]) }),
    );

    expect(result.books).toBe(books);
    expect(result.removedCount).toBe(0);
    expect(result.removedBooks).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  describe("an archived entry absent from both the scrape and the library ids", () => {
    const archived: BookEntry = { ...book(D), isArchived: BoolFlag.TRUE };
    const books = [book(A), archived];
    const reads = { scrapedIds: new Set([A]), libraryIds: new Set([A]) };

    it("is kept while archive sync is off — the archive was never read", () => {
      const result = pruneRemovedBooks(
        books,
        ctxFor(books, { ...reads, syncArchived: BoolFlag.FALSE }),
      );

      expect(result.books).toBe(books);
      expect(result.removedCount).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("is removed while archive sync is on", () => {
      const result = pruneRemovedBooks(
        books,
        ctxFor(books, { ...reads, syncArchived: BoolFlag.TRUE }),
      );

      expect(result.books.map((b) => b.bookId)).toEqual([A]);
      expect(result.removedBooks).toEqual([
        { bookId: D, isShared: BoolFlag.FALSE },
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it("counts removed shared books and normalises their share flag", () => {
    const missingFlag = {
      ...book(C),
      isShared: undefined as unknown as BoolFlag,
    };
    const books = [
      book(A),
      book(B, BoolFlag.TRUE),
      missingFlag,
      ...realIds(5).map((id) => book(id)),
    ];
    const kept = [A, ...realIds(5)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, {
        scrapedIds: new Set(kept),
        libraryIds: new Set(kept),
      }),
    );

    expect(result.removedBooks).toEqual([
      { bookId: B, isShared: BoolFlag.TRUE },
      { bookId: C, isShared: BoolFlag.FALSE },
    ]);
    expect(result.removedCount).toBe(2);
    expect(result.removedSharedCount).toBe(1);
  });

  it("preserves list order and does not mutate the input", () => {
    const books = [
      book(A),
      book(C),
      book(B),
      book(D),
      ...realIds(4).map((id) => book(id)),
    ];
    const before = structuredClone(books);
    const kept = [A, B, ...realIds(4)];

    const result = pruneRemovedBooks(
      books,
      ctxFor(books, {
        scrapedIds: new Set(kept),
        libraryIds: new Set(kept),
      }),
    );

    expect(result.books.map((b) => b.bookId)).toEqual([A, B, ...realIds(4)]);
    expect(result.removedBooks.map((b) => b.bookId)).toEqual([C, D]);
    expect(result.books).not.toBe(books);
    expect(books).toEqual(before);
    // Kept entries are passed through, not copied.
    expect(result.books[0]).toBe(books[0]);
  });
});
