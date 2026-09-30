import { describe, it, expect } from "vitest";
import {
  REAL_BOOK_ID_PATTERN,
  dropResolvedLegacyBooks,
  isLegacyBookEntry,
  isRealBookId,
} from "@/sync/legacyBooks";
import { BoolFlag, type BookEntry } from "@/api/client";

// Real Readmoo book ids are 15 digits; the legacy `.privacy` fallback path
// uploaded 7–8 digit internal ids instead (#234).
const REAL_A = "210180801000101";
const REAL_B = "210180801000102";
const REAL_C = "210180801000103";
const LEGACY_A = "14563038";
const LEGACY_B = "1456303";

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId: REAL_A,
    title: "書名",
    author: "作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.FALSE,
    ...overrides,
  };
}

/** Deep snapshot so a mutation of the input (array or element) is detectable. */
function snapshot(books: BookEntry[]): BookEntry[] {
  return books.map((b) => ({ ...b }));
}

describe("isRealBookId", () => {
  const cases: Array<{ name: string; id: unknown; expected: boolean }> = [
    { name: "a 15-digit book id", id: REAL_A, expected: true },
    {
      name: "a 12-digit id (the threshold)",
      id: "123456789012",
      expected: true,
    },
    { name: "an 18-digit id", id: "123456789012345678", expected: true },
    { name: "an 11-digit id", id: "12345678901", expected: false },
    { name: "an 8-digit legacy id", id: LEGACY_A, expected: false },
    { name: "a 7-digit legacy id", id: LEGACY_B, expected: false },
    { name: "an empty string", id: "", expected: false },
    { name: "non-digit characters", id: "abcdefghijklmno", expected: false },
    { name: "digits with a letter", id: "21018080100010a", expected: false },
    { name: "a leading space", id: ` ${REAL_A}`, expected: false },
    { name: "a trailing newline", id: `${REAL_A}\n`, expected: false },
    { name: "a prefixed id", id: `privacy-${REAL_A}`, expected: false },
    { name: "a number (not a string)", id: 210180801000101, expected: false },
    { name: "null", id: null, expected: false },
    { name: "undefined", id: undefined, expected: false },
    { name: "an object", id: { id: REAL_A }, expected: false },
  ];

  for (const { name, id, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isRealBookId(id)).toBe(expected);
    });
  }

  it("agrees with the exported REAL_BOOK_ID_PATTERN", () => {
    expect(REAL_BOOK_ID_PATTERN.test(REAL_A)).toBe(true);
    expect(REAL_BOOK_ID_PATTERN.test(LEGACY_A)).toBe(false);
  });
});

describe("isLegacyBookEntry", () => {
  it("flags an entry keyed by a short id", () => {
    expect(isLegacyBookEntry(makeBook({ bookId: LEGACY_A }))).toBe(true);
  });

  it("does not flag an entry keyed by a real id", () => {
    expect(isLegacyBookEntry(makeBook({ bookId: REAL_A }))).toBe(false);
  });
});

describe("dropResolvedLegacyBooks", () => {
  it("drops a legacy entry that has exactly one same-title real entry", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "三體" }),
      makeBook({ bookId: REAL_A, title: "三體" }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result.map((b) => b.bookId)).toEqual([REAL_A]);
  });

  it("keeps a legacy entry with no same-title real entry, returning the same array", () => {
    const books = [
      makeBook({
        bookId: LEGACY_A,
        title: "只在舊資料裡",
        isShared: BoolFlag.TRUE,
      }),
      makeBook({ bookId: REAL_A, title: "別本書" }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result).toBe(books);
    expect(result).toEqual([
      makeBook({
        bookId: LEGACY_A,
        title: "只在舊資料裡",
        isShared: BoolFlag.TRUE,
      }),
      makeBook({ bookId: REAL_A, title: "別本書" }),
    ]);
  });

  it("keeps a legacy entry when two or more real entries share its title (ambiguous)", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "同名書", isShared: BoolFlag.TRUE }),
      makeBook({ bookId: REAL_A, title: "同名書" }),
      makeBook({ bookId: REAL_B, title: "同名書" }),
    ];
    const before = snapshot(books);

    const result = dropResolvedLegacyBooks(books);

    expect(result).toBe(books);
    // Nothing removed, and the ambiguous share flag is not pushed onto either twin.
    expect(result).toEqual(before);
    expect(result.filter((b) => b.isShared === BoolFlag.TRUE)).toHaveLength(1);
  });

  it("matches titles after trimming surrounding whitespace on both sides", () => {
    const books = [
      makeBook({
        bookId: LEGACY_A,
        title: "  三體\n",
        isShared: BoolFlag.TRUE,
      }),
      makeBook({ bookId: REAL_A, title: "\t三體 " }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe(REAL_A);
    expect(result[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("does not match titles that differ beyond surrounding whitespace", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "三體 I" }),
      makeBook({ bookId: REAL_A, title: "三體" }),
    ];

    expect(dropResolvedLegacyBooks(books)).toBe(books);
  });

  it.each([
    { name: "an empty title", title: "" },
    { name: "a whitespace-only title", title: "   " },
  ])(
    "keeps a legacy entry with $name even when a real entry has the same title",
    ({ title }) => {
      const books = [
        makeBook({ bookId: LEGACY_A, title }),
        makeBook({ bookId: REAL_A, title }),
      ];

      const result = dropResolvedLegacyBooks(books);

      expect(result).toBe(books);
      expect(result.map((b) => b.bookId)).toEqual([LEGACY_A, REAL_A]);
    },
  );

  it("carries a shared legacy entry's flag onto its real twin", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "三體", isShared: BoolFlag.TRUE }),
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.FALSE }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result).toEqual([
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.TRUE }),
    ]);
  });

  it("leaves a real twin that is already shared as shared", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "三體", isShared: BoolFlag.TRUE }),
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.TRUE }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe(REAL_A);
    expect(result[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("never clears a shared real twin when the dropped legacy entry was not shared", () => {
    const books = [
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.TRUE }),
      makeBook({ bookId: LEGACY_A, title: "三體", isShared: BoolFlag.FALSE }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe(REAL_A);
    expect(result[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("keeps a real twin unshared when the dropped legacy entry was not shared", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "三體", isShared: BoolFlag.FALSE }),
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.FALSE }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result).toEqual([
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.FALSE }),
    ]);
  });

  it("drops every legacy entry resolving to the same real entry and promotes if any was shared", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "三體", isShared: BoolFlag.FALSE }),
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.FALSE }),
      makeBook({ bookId: LEGACY_B, title: "三體", isShared: BoolFlag.TRUE }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result).toEqual([
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.TRUE }),
    ]);
  });

  it("keeps two same-title legacy entries when no real entry carries that title", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "舊書" }),
      makeBook({ bookId: LEGACY_B, title: "舊書" }),
    ];

    expect(dropResolvedLegacyBooks(books)).toBe(books);
  });

  it("returns the same array for a list with no legacy entries", () => {
    const books = [
      makeBook({ bookId: REAL_A, title: "一" }),
      makeBook({ bookId: REAL_B, title: "二" }),
    ];

    expect(dropResolvedLegacyBooks(books)).toBe(books);
  });

  it("returns the same array for a legacy-only list (no real ids at all)", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "一", isShared: BoolFlag.TRUE }),
      makeBook({ bookId: LEGACY_B, title: "二" }),
    ];
    const before = snapshot(books);

    const result = dropResolvedLegacyBooks(books);

    expect(result).toBe(books);
    expect(result).toEqual(before);
  });

  it("returns an empty list unchanged", () => {
    const books: BookEntry[] = [];
    expect(dropResolvedLegacyBooks(books)).toBe(books);
  });

  it("preserves the relative order of the surviving entries", () => {
    const books = [
      makeBook({ bookId: REAL_C, title: "丙" }),
      makeBook({ bookId: LEGACY_A, title: "甲", isShared: BoolFlag.TRUE }),
      makeBook({ bookId: REAL_B, title: "乙" }),
      makeBook({ bookId: LEGACY_B, title: "無對應" }),
      makeBook({ bookId: REAL_A, title: "甲" }),
    ];

    const result = dropResolvedLegacyBooks(books);

    expect(result.map((b) => b.bookId)).toEqual([
      REAL_C,
      REAL_B,
      LEGACY_B,
      REAL_A,
    ]);
    expect(result[3].isShared).toBe(BoolFlag.TRUE);
  });

  it("does not mutate the input array or its entries when promoting", () => {
    const books = [
      makeBook({ bookId: LEGACY_A, title: "三體", isShared: BoolFlag.TRUE }),
      makeBook({ bookId: REAL_A, title: "三體", isShared: BoolFlag.FALSE }),
    ];
    const before = snapshot(books);
    const realEntry = books[1];

    const result = dropResolvedLegacyBooks(books);

    expect(books).toEqual(before);
    expect(books).toHaveLength(2);
    expect(realEntry.isShared).toBe(BoolFlag.FALSE);
    expect(result).not.toBe(books);
    // The promoted entry is a new object, not the input entry rewritten.
    expect(result[0]).not.toBe(realEntry);
    expect(result[0].isShared).toBe(BoolFlag.TRUE);
  });
});
