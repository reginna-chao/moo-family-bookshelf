import { describe, it, expect } from "vitest";
import {
  combineScrapeResults,
  failedScrape,
  isLibraryScrapeComplete,
} from "@/content/scrapeResult";
import { BoolFlag } from "@/api/client";
import type { ScrapedBook } from "@/content/scraper";

function makeScraped(bookId: string, isArchived = BoolFlag.FALSE): ScrapedBook {
  return {
    bookId,
    title: `書 ${bookId}`,
    author: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isArchived,
  };
}

describe("isLibraryScrapeComplete", () => {
  it.each([
    { skippedCount: 0, paginationComplete: true, expected: true },
    { skippedCount: 1, paginationComplete: true, expected: false },
    { skippedCount: 0, paginationComplete: false, expected: false },
    { skippedCount: 3, paginationComplete: false, expected: false },
  ])(
    "skipped=$skippedCount paginationComplete=$paginationComplete → $expected",
    ({ skippedCount, paginationComplete, expected }) => {
      expect(
        isLibraryScrapeComplete({ skippedCount, paginationComplete }),
      ).toBe(expected);
    },
  );
});

describe("failedScrape", () => {
  it("is empty and incomplete", () => {
    expect(failedScrape()).toEqual({ books: [], complete: false });
  });

  it("returns a fresh object each call", () => {
    const a = failedScrape();
    a.books.push(makeScraped("210000000000001"));
    expect(failedScrape().books).toEqual([]);
  });
});

describe("combineScrapeResults", () => {
  const library = {
    books: [makeScraped("210000000000001")],
    complete: true,
  };

  it("returns the library unchanged when the archive is not synced", () => {
    expect(combineScrapeResults(library, null)).toBe(library);
  });

  it.each([
    { libraryComplete: true, archiveComplete: true, expected: true },
    { libraryComplete: true, archiveComplete: false, expected: false },
    { libraryComplete: false, archiveComplete: true, expected: false },
    { libraryComplete: false, archiveComplete: false, expected: false },
  ])(
    "library=$libraryComplete archive=$archiveComplete → complete=$expected",
    ({ libraryComplete, archiveComplete, expected }) => {
      const archivedBook = makeScraped("210000000000002", BoolFlag.TRUE);
      const result = combineScrapeResults(
        { books: library.books, complete: libraryComplete },
        { books: [archivedBook], complete: archiveComplete },
      );
      expect(result).toEqual({
        books: [...library.books, archivedBook],
        complete: expected,
      });
    },
  );

  it("makes the combined result incomplete when the archive scrape failed", () => {
    expect(combineScrapeResults(library, failedScrape())).toEqual({
      books: library.books,
      complete: false,
    });
  });
});
