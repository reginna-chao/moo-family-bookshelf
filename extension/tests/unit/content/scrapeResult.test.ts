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

/**
 * Completeness needs POSITIVE confirmation (#236 F1): Readmoo's own item count
 * must be known and equal the cards read. "Scrolling stopped growing" alone is
 * what a slow next page looks like, so it never confirms the end of the list.
 */
describe("isLibraryScrapeComplete", () => {
  it.each([
    {
      name: "the total is known and matches, nothing skipped, below the cap",
      stats: {
        skippedCount: 0,
        belowPageCap: true,
        listTotal: 5,
        itemCount: 5,
      },
      expected: true,
    },
    {
      name: "an empty list confirmed by a published total of 0",
      stats: {
        skippedCount: 0,
        belowPageCap: true,
        listTotal: 0,
        itemCount: 0,
      },
      expected: true,
    },
    {
      name: "the total is unknown (bridge silent / legacy host / redesign)",
      stats: {
        skippedCount: 0,
        belowPageCap: true,
        listTotal: null,
        itemCount: 5,
      },
      expected: false,
    },
    {
      name: "an empty DOM with an unknown total",
      stats: {
        skippedCount: 0,
        belowPageCap: true,
        listTotal: null,
        itemCount: 0,
      },
      expected: false,
    },
    {
      name: "fewer cards than the total (next page not rendered yet)",
      stats: {
        skippedCount: 0,
        belowPageCap: true,
        listTotal: 6,
        itemCount: 5,
      },
      expected: false,
    },
    {
      name: "more cards than the total",
      stats: {
        skippedCount: 0,
        belowPageCap: true,
        listTotal: 4,
        itemCount: 5,
      },
      expected: false,
    },
    {
      name: "an own card was skipped",
      stats: {
        skippedCount: 1,
        belowPageCap: true,
        listTotal: 5,
        itemCount: 5,
      },
      expected: false,
    },
    {
      name: "pagination stopped at its hard cap",
      stats: {
        skippedCount: 0,
        belowPageCap: false,
        listTotal: 5,
        itemCount: 5,
      },
      expected: false,
    },
    {
      name: "a skip AND the hard cap",
      stats: {
        skippedCount: 3,
        belowPageCap: false,
        listTotal: 5,
        itemCount: 5,
      },
      expected: false,
    },
  ])("$name → $expected", ({ stats, expected }) => {
    expect(isLibraryScrapeComplete(stats)).toBe(expected);
  });
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
