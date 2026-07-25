import { describe, it, expect } from "vitest";
import { sortBooks, normalizeSortMode } from "@/utils/sortBooks";
import type { BookSortMode } from "@/utils/sortBooks";

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

  it.each<BookSortMode>([
    "title-asc",
    "title-desc",
    "author-asc",
    "author-desc",
  ])("does not mutate the input array for '%s'", (mode) => {
    const copy = [...books];
    sortBooks(books, mode);
    expect(books).toEqual(copy);
  });

  it.each<BookSortMode>([
    "default",
    "title-asc",
    "title-desc",
    "author-asc",
    "author-desc",
  ])("returns empty array for empty input with '%s'", (mode) => {
    expect(sortBooks([], mode)).toEqual([]);
  });

  describe("sort by title", () => {
    it("sorts titles ascending in zh-Hant collation order for 'title-asc'", () => {
      const sorted = sortBooks(books, "title-asc");
      const titles = sorted.map((b) => b.title);
      // zh-Hant collator: Chinese stroke order first, then Latin
      expect(titles).toEqual(["一九八四", "三國演義", "百年孤寂", "Apple"]);
    });

    it("returns the exact reverse of 'title-asc' for 'title-desc'", () => {
      const asc = sortBooks(books, "title-asc").map((b) => b.id);
      const desc = sortBooks(books, "title-desc").map((b) => b.id);
      expect(desc).toEqual([...asc].reverse());
    });
  });

  describe("sort by author", () => {
    it("sorts authors ascending in zh-Hant collation order for 'author-asc'", () => {
      const sorted = sortBooks(books, "author-asc");
      const authors = sorted.map((b) => b.author);
      expect(authors).toEqual(["羅貫中", "John", "Marquez", "Orwell"]);
    });

    it("returns the exact reverse of 'author-asc' for 'author-desc'", () => {
      const asc = sortBooks(books, "author-asc").map((b) => b.id);
      const desc = sortBooks(books, "author-desc").map((b) => b.id);
      expect(desc).toEqual([...asc].reverse());
    });
  });

  describe("stable sort", () => {
    it("preserves input order for equal sort keys in ascending mode", () => {
      const dupes: TestBook[] = [
        { title: "Same", author: "A", id: 10 },
        { title: "Same", author: "B", id: 20 },
        { title: "Same", author: "C", id: 30 },
      ];
      const sorted = sortBooks(dupes, "title-asc");
      expect(sorted.map((b) => b.id)).toEqual([10, 20, 30]);
    });

    it("preserves input order for equal sort keys in descending mode", () => {
      const dupes: TestBook[] = [
        { title: "Same", author: "A", id: 10 },
        { title: "Same", author: "B", id: 20 },
        { title: "Same", author: "C", id: 30 },
      ];
      const sorted = sortBooks(dupes, "title-desc");
      // Equal keys must NOT be reversed: descending only affects unequal keys,
      // tied items keep their original input order (stable sort).
      expect(sorted.map((b) => b.id)).toEqual([10, 20, 30]);
    });
  });
});

describe("normalizeSortMode", () => {
  it.each<{ input: unknown; expected: BookSortMode; desc: string }>([
    { input: "default", expected: "default", desc: "canonical default" },
    { input: "title-asc", expected: "title-asc", desc: "canonical title-asc" },
    {
      input: "title-desc",
      expected: "title-desc",
      desc: "canonical title-desc",
    },
    {
      input: "author-asc",
      expected: "author-asc",
      desc: "canonical author-asc",
    },
    {
      input: "author-desc",
      expected: "author-desc",
      desc: "canonical author-desc",
    },
    { input: "title", expected: "title-asc", desc: "legacy title alias" },
    { input: "author", expected: "author-asc", desc: "legacy author alias" },
    { input: "bogus", expected: "default", desc: "unknown string" },
    { input: "", expected: "default", desc: "empty string" },
    { input: null, expected: "default", desc: "null" },
    { input: undefined, expected: "default", desc: "undefined" },
    { input: 42, expected: "default", desc: "number" },
    { input: {}, expected: "default", desc: "object" },
    // Regression guard (W1): prototype-chain keys must not resolve to inherited
    // Object/Function members via LEGACY_ALIASES lookup. The Object.hasOwn guard
    // makes these fall back to 'default' instead of returning an object/function.
    {
      input: "__proto__",
      expected: "default",
      desc: "prototype-chain key __proto__",
    },
    {
      input: "constructor",
      expected: "default",
      desc: "prototype-chain key constructor",
    },
    {
      input: "toString",
      expected: "default",
      desc: "prototype-chain key toString",
    },
  ])("normalizes $desc to '$expected'", ({ input, expected }) => {
    expect(normalizeSortMode(input)).toBe(expected);
  });
});
