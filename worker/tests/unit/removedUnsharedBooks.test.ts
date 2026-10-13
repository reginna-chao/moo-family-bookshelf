import { describe, it, expect } from "vitest";
import { nextRemovedUnsharedBookIds } from "../../src/services/removedUnsharedBooks";
import {
  BoolFlag,
  MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH,
  MAX_REMOVED_UNSHARED_BOOK_IDS,
  type BookEntry,
} from "../../src/kv/schema";

/**
 * nextRemovedUnsharedBookIds (#312) — the pure rule behind the server-owned
 * `removedUnsharedBookIds` list that `PUT /api/user/:id/books` stores.
 *
 * Steps: (1) the stored list is normalised — a non-array is `[]`, only strings
 * passing `isRealBookId` (12+ digits) survive, duplicates collapse in order;
 * (2) every id present in the next books is dropped (the book is back and its
 * own `isShared` carries the choice); (3) every real-id book of the previous
 * books that was NOT shared and is absent from the next books is appended in
 * previous-books order, skipping ids already listed; (4) only the newest
 * `MAX_REMOVED_UNSHARED_BOOK_IDS` entries are kept, oldest first.
 *
 * Id length cap: a real id longer than `MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH`
 * (32) is never tombstoned and is dropped from the stored list on
 * normalisation — the count cap alone let a multi-megabyte numeric bookId grow
 * the `user:{id}` record across PUTs (#312 review C1).
 *
 * The stored record is CAST from KV, not validated, so the defensive rows
 * (a boolean `isShared`, a missing flag, null entries) model hand-edited or
 * pre-BoolFlag records: anything other than exactly `BoolFlag.TRUE` counts as
 * not shared — a tombstone only ever keeps a book unshared.
 */

const A = "210439468000101";
const B = "210439468000102";
const C = "210439468000103";
const D = "210439468000104";
/** A legacy short id: kept in stored records, never a tombstone. */
const LEGACY = "b1";

function book(bookId: string, isShared: BoolFlag): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared,
  };
}

/** `count` distinct real ids starting at `start` (15 digits each). */
function realIds(count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, i) =>
    String(210439460000000 + start + i),
  );
}

describe("nextRemovedUnsharedBookIds — step 1: normalising the stored list", () => {
  it.each<{ label: string; stored: unknown }>([
    { label: "undefined (no list yet)", stored: undefined },
    { label: "null", stored: null },
    { label: "a string", stored: A },
    { label: "an object", stored: { 0: A, length: 1 } },
    { label: "a number", stored: 210439468000101 },
    { label: "an empty array", stored: [] },
  ])("treats $label as an empty list", ({ stored }) => {
    expect(nextRemovedUnsharedBookIds(stored, [], [])).toEqual([]);
  });

  it("keeps only real-id strings from a mixed array", () => {
    const stored = [A, 210439468000102, LEGACY, null, { bookId: C }, "", D];

    expect(nextRemovedUnsharedBookIds(stored, [], [])).toEqual([A, D]);
  });

  it("collapses duplicates and keeps the first occurrence's position", () => {
    expect(nextRemovedUnsharedBookIds([A, B, A, C, B], [], [])).toEqual([
      A,
      B,
      C,
    ]);
  });
});

describe("nextRemovedUnsharedBookIds — step 2: a returning book leaves the list", () => {
  it("drops a listed id the next books contain and keeps the rest in order", () => {
    const next = [book(B, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds([A, B, C], [], next)).toEqual([A, C]);
  });

  it("drops a returning id whatever flag it comes back with", () => {
    const next = [book(A, BoolFlag.TRUE), book(B, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds([A, B], [], next)).toEqual([]);
  });
});

describe("nextRemovedUnsharedBookIds — step 3: tombstoning removed unshared books", () => {
  it("appends a real-id book removed while not shared", () => {
    const existing = [book(A, BoolFlag.FALSE), book(B, BoolFlag.TRUE)];
    const next = [book(B, BoolFlag.TRUE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, next)).toEqual([A]);
  });

  it("never tombstones a book removed while shared", () => {
    const existing = [book(A, BoolFlag.TRUE), book(B, BoolFlag.FALSE)];
    const next = [book(B, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, next)).toEqual([]);
  });

  it("never tombstones a removed legacy short id", () => {
    const existing = [book(LEGACY, BoolFlag.FALSE), book(A, BoolFlag.FALSE)];
    const next = [book(A, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, next)).toEqual([]);
  });

  it("never tombstones an unshared book that is still in the next books", () => {
    const existing = [book(A, BoolFlag.FALSE)];
    const next = [book(A, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, next)).toEqual([]);
  });

  it.each<{ label: string; entry: Record<string, unknown> }>([
    { label: "isShared missing", entry: { bookId: A, title: "t" } },
    { label: "isShared boolean true", entry: { bookId: A, isShared: true } },
    { label: "isShared null", entry: { bookId: A, isShared: null } },
    { label: "isShared the string 1", entry: { bookId: A, isShared: "1" } },
  ])("treats a stored book with $label as not shared", ({ entry }) => {
    expect(nextRemovedUnsharedBookIds(undefined, [entry], [])).toEqual([A]);
  });

  it("appends in previous-books order after the stored entries", () => {
    const existing = [
      book(D, BoolFlag.FALSE),
      book(C, BoolFlag.TRUE),
      book(B, BoolFlag.FALSE),
    ];

    expect(nextRemovedUnsharedBookIds([A], existing, [])).toEqual([A, D, B]);
  });

  it("does not move or duplicate an id that is already listed", () => {
    const existing = [book(B, BoolFlag.FALSE), book(C, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds([B, A], existing, [])).toEqual([B, A, C]);
  });

  it("appends an id listed twice in the previous books only once", () => {
    const existing = [book(A, BoolFlag.FALSE), book(A, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, [])).toEqual([A]);
  });

  it.each<{ label: string; existing: unknown }>([
    { label: "undefined (no record yet)", existing: undefined },
    { label: "null", existing: null },
    { label: "a non-array value", existing: { books: [] } },
  ])("appends nothing when the previous books are $label", ({ existing }) => {
    expect(nextRemovedUnsharedBookIds([A], existing, [])).toEqual([A]);
  });

  it("skips null and undefined entries in the previous books", () => {
    const existing = [null, undefined, book(A, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, [])).toEqual([A]);
  });

  it("does not mutate its inputs", () => {
    const stored = [A, A];
    const existing = [book(B, BoolFlag.FALSE)];
    const next = [book(C, BoolFlag.FALSE)];
    const snapshot = JSON.stringify({ stored, existing, next });

    nextRemovedUnsharedBookIds(stored, existing, next);

    expect(JSON.stringify({ stored, existing, next })).toBe(snapshot);
  });
});

describe("nextRemovedUnsharedBookIds — step 4: the cap", () => {
  it("caps the list at 1000 entries", () => {
    // Pins the documented number as well as the constant the rule reads.
    expect(MAX_REMOVED_UNSHARED_BOOK_IDS).toBe(1000);
  });

  it("keeps a full list unchanged when nothing new is removed", () => {
    const stored = realIds(MAX_REMOVED_UNSHARED_BOOK_IDS);

    expect(nextRemovedUnsharedBookIds(stored, [], [])).toEqual(stored);
  });

  it("drops the OLDEST entries when a removal overflows the cap", () => {
    const stored = realIds(MAX_REMOVED_UNSHARED_BOOK_IDS);
    const existing = [book(A, BoolFlag.FALSE), book(B, BoolFlag.FALSE)];

    const result = nextRemovedUnsharedBookIds(stored, existing, []);

    expect(result).toHaveLength(MAX_REMOVED_UNSHARED_BOOK_IDS);
    expect(result).toEqual([...stored.slice(2), A, B]);
    expect(result).not.toContain(stored[0]);
    expect(result).not.toContain(stored[1]);
  });

  it("trims an over-cap stored list to its newest 1000 entries", () => {
    const stored = realIds(MAX_REMOVED_UNSHARED_BOOK_IDS + 5);

    expect(nextRemovedUnsharedBookIds(stored, [], [])).toEqual(stored.slice(5));
  });

  it("applies the cap after dropping returning ids, not before", () => {
    const stored = realIds(MAX_REMOVED_UNSHARED_BOOK_IDS + 1);
    const next = [book(stored[stored.length - 1], BoolFlag.FALSE)];

    const result = nextRemovedUnsharedBookIds(stored, [], next);

    expect(result).toEqual(stored.slice(0, MAX_REMOVED_UNSHARED_BOOK_IDS));
  });
});

describe("nextRemovedUnsharedBookIds — the id length cap", () => {
  /** A real (all-digit) id of exactly `length` characters. */
  const digits = (length: number) => "1".repeat(length);
  const AT_CAP = digits(MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH);
  const OVER_CAP = digits(MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH + 1);

  it("caps a listed id at 32 characters", () => {
    expect(MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH).toBe(32);
  });

  it("tombstones a removed unshared book whose id is exactly at the cap", () => {
    const existing = [book(AT_CAP, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, [])).toEqual([
      AT_CAP,
    ]);
  });

  it("never tombstones a removed unshared book whose id is one over the cap", () => {
    const existing = [book(OVER_CAP, BoolFlag.FALSE), book(A, BoolFlag.FALSE)];

    expect(nextRemovedUnsharedBookIds(undefined, existing, [])).toEqual([A]);
  });

  it("drops a stored entry one over the cap and keeps one at the cap", () => {
    const stored = [A, OVER_CAP, AT_CAP];

    expect(nextRemovedUnsharedBookIds(stored, [], [])).toEqual([A, AT_CAP]);
  });
});
