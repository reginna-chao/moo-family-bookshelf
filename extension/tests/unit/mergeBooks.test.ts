import { describe, it, expect } from "vitest";
import { mergeBooks } from "@/sync/mergeBooks";
import type { BookEntry } from "@/api/client";
import type { ScrapedBook } from "@/content/scraper";

function makeScraped(overrides: Partial<ScrapedBook> = {}): ScrapedBook {
  return {
    bookId: "book-1",
    title: "Test Book",
    author: "Author",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://mooink.readmoo.com/book/book-1",
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
    readmooUrl: "https://mooink.readmoo.com/book/book-1",
    isShared: false,
    ...overrides,
  };
}

describe("mergeBooks — isArchived", () => {
  it("scraped book with isArchived=0 merged with no saved → isArchived=0", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: 0 })];
    const saved: BookEntry[] = [];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(0);
  });

  it("scraped book with isArchived=1 merged with no saved → isArchived=1", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: 1 })];
    const saved: BookEntry[] = [];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(1);
  });

  it("scraped book (isArchived=1) merged with saved (isArchived=0) → uses scraped value (1)", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: 1 })];
    const saved = [makeSaved({ bookId: "b1", isArchived: 0 })];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(1);
  });

  it("scraped book (no isArchived) merged with saved (isArchived=1) → preserves saved value (1)", () => {
    const scraped = [makeScraped({ bookId: "b1", isArchived: undefined })];
    const saved = [makeSaved({ bookId: "b1", isArchived: 1 })];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(1);
  });

  it("saved-only book with isArchived=1 stays as-is", () => {
    const scraped: ScrapedBook[] = [];
    const saved = [makeSaved({ bookId: "b1", isArchived: 1, isShared: true })];

    const result = mergeBooks(scraped, saved);

    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("b1");
    expect(result[0].isArchived).toBe(1);
    expect(result[0].isShared).toBe(true);
  });
});
