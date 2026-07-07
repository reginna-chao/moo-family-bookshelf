import { describe, it, expect } from "vitest";
import { sortBooks, normalizeSortMode } from "@/dialog/sortBooks";
import type { BookSortMode } from "@/dialog/sortBooks";

interface TestBook {
  title: string;
  author: string;
  id: number;
}

const books: TestBook[] = [
  { title: "三國演義", author: "羅貫中", id: 1 },
  { title: "Apple", author: "John", id: 2 },
  { title: "百年孤寂", author: "Marquez", id: 3 },
  { title: "一九八四", author: "Orwell", id: 4 },
];

describe("sortBooks", () => {
  it("returns same reference for 'default' mode", () => {
    const result = sortBooks(books, "default");
    expect(result).toBe(books);
  });

  it("does not mutate the input array", () => {
    const copy = [...books];
    sortBooks(books, "title-asc");
    sortBooks(books, "title-desc");
    sortBooks(books, "author-asc");
    sortBooks(books, "author-desc");
    expect(books).toEqual(copy);
  });

  it.each<BookSortMode>(["title-asc", "title-desc", "author-asc", "author-desc"])(
    "returns empty array for empty input (%s)",
    (mode) => {
      expect(sortBooks([], mode)).toEqual([]);
    },
  );

  it.each<BookSortMode>(["title-asc", "title-desc", "author-asc", "author-desc"])(
    "returns single-element array unchanged (%s)",
    (mode) => {
      const single = [{ title: "A", author: "B" }];
      const result = sortBooks(single, mode);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("A");
    },
  );

  describe("sort by title", () => {
    // zh-Hant collator: Chinese stroke order first, then Latin.
    const ASC = ["一九八四", "三國演義", "百年孤寂", "Apple"];

    it("title-asc sorts mixed Chinese/English titles in zh-Hant collation order", () => {
      const sorted = sortBooks(books, "title-asc");
      expect(sorted.map((b) => b.title)).toEqual(ASC);
    });

    it("title-desc is the exact reversal of title-asc", () => {
      const asc = sortBooks(books, "title-asc").map((b) => b.title);
      const desc = sortBooks(books, "title-desc").map((b) => b.title);
      expect(desc).toEqual([...asc].reverse());
    });
  });

  describe("sort by author", () => {
    const ASC = ["羅貫中", "John", "Marquez", "Orwell"];

    it("author-asc sorts mixed Chinese/English authors in zh-Hant collation order", () => {
      const sorted = sortBooks(books, "author-asc");
      expect(sorted.map((b) => b.author)).toEqual(ASC);
    });

    it("author-desc is the exact reversal of author-asc", () => {
      const asc = sortBooks(books, "author-asc").map((b) => b.author);
      const desc = sortBooks(books, "author-desc").map((b) => b.author);
      expect(desc).toEqual([...asc].reverse());
    });
  });

  describe("stable sort", () => {
    it("preserves input order for equal sort keys (asc)", () => {
      const dupes: TestBook[] = [
        { title: "Same", author: "A", id: 10 },
        { title: "Same", author: "B", id: 20 },
        { title: "Same", author: "C", id: 30 },
      ];
      const sorted = sortBooks(dupes, "title-asc");
      expect(sorted.map((b) => b.id)).toEqual([10, 20, 30]);
    });

    it("preserves input order for equal sort keys (desc)", () => {
      const dupes: TestBook[] = [
        { title: "Same", author: "A", id: 10 },
        { title: "Same", author: "B", id: 20 },
        { title: "Same", author: "C", id: 30 },
      ];
      const sorted = sortBooks(dupes, "title-desc");
      expect(sorted.map((b) => b.id)).toEqual([10, 20, 30]);
    });
  });

  describe("case insensitivity", () => {
    it("treats different cases as equal", () => {
      const mixed = [
        { title: "banana", author: "x" },
        { title: "Banana", author: "y" },
        { title: "APPLE", author: "z" },
      ];
      const sorted = sortBooks(mixed, "title-asc");
      expect(sorted[0].title).toBe("APPLE");
    });
  });
});

describe("normalizeSortMode", () => {
  it.each<{ input: unknown; expected: BookSortMode }>([
    { input: "default", expected: "default" },
    { input: "title-asc", expected: "title-asc" },
    { input: "title-desc", expected: "title-desc" },
    { input: "author-asc", expected: "author-asc" },
    { input: "author-desc", expected: "author-desc" },
  ])("passes canonical value '$input' through unchanged", ({ input, expected }) => {
    expect(normalizeSortMode(input)).toBe(expected);
  });

  it.each<{ input: string; expected: BookSortMode }>([
    { input: "title", expected: "title-asc" },
    { input: "author", expected: "author-asc" },
  ])("maps legacy alias '$input' to its -asc canonical form", ({ input, expected }) => {
    expect(normalizeSortMode(input)).toBe(expected);
  });

  it.each<{ label: string; input: unknown }>([
    { label: "unknown string", input: "bogus" },
    { label: "title-up (bad direction)", input: "title-up" },
    { label: "empty string", input: "" },
    { label: "number", input: 42 },
    { label: "null", input: null },
    { label: "undefined", input: undefined },
    { label: "object", input: { sort: "title-asc" } },
    { label: "boolean", input: true },
  ])("falls back to 'default' for $label", ({ input }) => {
    expect(normalizeSortMode(input)).toBe("default");
  });

  // Regression guard (W1): prototype-chain keys must not resolve to inherited
  // Object/Function members via LEGACY_ALIASES lookup. The Object.hasOwn guard
  // makes these fall back to 'default' instead of returning an object/function.
  it.each<string>(["__proto__", "constructor", "toString"])(
    "falls back to 'default' for prototype-chain key '%s'",
    (input) => {
      expect(normalizeSortMode(input)).toBe("default");
    },
  );
});
