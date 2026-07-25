import { describe, it, expect } from "vitest";
import { mergeBooks } from "@/sync/mergeBooks";
import { BoolFlag, type BookEntry } from "@/api/client";
import type { ScrapedBook } from "@/content/scraper";

function makeScraped(overrides: Partial<ScrapedBook> = {}): ScrapedBook {
  return {
    bookId: "book-1",
    title: "Test Book",
    author: "Author",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    ...overrides,
  };
}

function makeSaved(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId: "book-1",
    title: "Test Book",
    author: "Author",
    isbn: "978-0000000000",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    isShared: BoolFlag.FALSE,
    ...overrides,
  };
}

describe("mergeBooks — isArchived", () => {
  it("scraped book with isArchived=0 merged with no saved → isArchived=0", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: BoolFlag.FALSE })];
    const saved: BookEntry[] = [];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(BoolFlag.FALSE);
  });

  it("scraped book with isArchived=1 merged with no saved → isArchived=1", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: BoolFlag.TRUE })];
    const saved: BookEntry[] = [];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(BoolFlag.TRUE);
  });

  it("scraped book (isArchived=1) merged with saved (isArchived=0) → uses scraped value (1)", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: BoolFlag.TRUE })];
    const saved = [makeSaved({ bookId: "b1", isArchived: BoolFlag.FALSE })];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(BoolFlag.TRUE);
  });

  it("scraped book (no isArchived) merged with saved (isArchived=1) → preserves saved value (1)", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: undefined })];
    const saved = [makeSaved({ bookId: "b1", isArchived: BoolFlag.TRUE })];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(BoolFlag.TRUE);
  });

  it("saved-only book with isArchived=1 stays as-is", () => {
    const scraped: ScrapedBook[] = [];
    const saved = [
      makeSaved({ bookId: "b1", isArchived: 1, isShared: BoolFlag.TRUE }),
    ];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("b1");
    expect(result[0].isArchived).toBe(BoolFlag.TRUE);
    expect(result[0].isShared).toBe(BoolFlag.TRUE);
  });
});

describe("mergeBooks — category", () => {
  it("scraped category takes priority over saved", () => {
    const scraped = [makeScraped({ bookId: "b1", category: "奇幻冒險" })];
    const saved = [makeSaved({ bookId: "b1", category: "文學小說" })];

    const result = mergeBooks(scraped, saved);

    expect(result[0].category).toBe("奇幻冒險");
  });

  it("falls back to saved category when scraped is empty", () => {
    const scraped = [makeScraped({ bookId: "b1", category: "" })];
    const saved = [makeSaved({ bookId: "b1", category: "韓國耽美" })];

    const result = mergeBooks(scraped, saved);

    expect(result[0].category).toBe("韓國耽美");
  });

  it("scraped-only book keeps its category", () => {
    const scraped = [makeScraped({ bookId: "b1", category: "軍事\\戰略" })];
    const saved: BookEntry[] = [];

    const result = mergeBooks(scraped, saved);

    expect(result[0].category).toBe("軍事\\戰略");
  });

  it("saved-only book keeps its category", () => {
    const scraped: ScrapedBook[] = [];
    const saved = [makeSaved({ bookId: "b1", category: "西洋羅曼史" })];

    const result = mergeBooks(scraped, saved);

    expect(result[0].category).toBe("西洋羅曼史");
  });
});
