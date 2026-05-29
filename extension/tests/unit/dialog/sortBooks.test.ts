import { describe, it, expect } from "vitest";
import { sortBooks } from "@/dialog/sortBooks";
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
    sortBooks(books, "title");
    expect(books).toEqual(copy);
  });

  it("returns empty array for empty input", () => {
    expect(sortBooks([], "title")).toEqual([]);
  });

  it("returns single-element array unchanged", () => {
    const single = [{ title: "A", author: "B" }];
    const result = sortBooks(single, "title");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("A");
  });

  describe("sort by title", () => {
    it("sorts mixed Chinese/English titles in zh-Hant collation order", () => {
      const sorted = sortBooks(books, "title");
      const titles = sorted.map((b) => b.title);
      // zh-Hant collator: Chinese stroke order first, then Latin
      expect(titles).toEqual(["一九八四", "三國演義", "百年孤寂", "Apple"]);
    });
  });

  describe("sort by author", () => {
    it("sorts mixed Chinese/English authors in zh-Hant collation order", () => {
      const sorted = sortBooks(books, "author");
      const authors = sorted.map((b) => b.author);
      expect(authors).toEqual(["羅貫中", "John", "Marquez", "Orwell"]);
    });
  });

  describe("stable sort", () => {
    it("preserves input order for equal sort keys", () => {
      const dupes: TestBook[] = [
        { title: "Same", author: "A", id: 10 },
        { title: "Same", author: "B", id: 20 },
        { title: "Same", author: "C", id: 30 },
      ];
      const sorted = sortBooks(dupes, "title");
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
      const sorted = sortBooks(mixed, "title");
      expect(sorted[0].title).toBe("APPLE");
    });
  });
});
