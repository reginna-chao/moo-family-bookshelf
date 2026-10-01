/**
 * Completeness of a library scrape — pure rules, no DOM.
 *
 * A scrape is COMPLETE only when it saw every book the user owns: no own book
 * was skipped, pagination ended on its own, and (when archived books are
 * synced) the archive scrape succeeded. Only a complete scrape may be used to
 * conclude that a saved book is missing from Readmoo (see
 * `sync/renamedBooks.ts`); an incomplete one is still uploaded, additively.
 */

import type { ScrapedBook } from "./scraper";

export interface ScrapeResult {
  books: ScrapedBook[];
  complete: boolean;
}

export interface LibraryScrapeStats {
  /** Own (non-borrowed) cards dropped for a missing title or a missing / rejected id. */
  skippedCount: number;
  /** False when pagination stopped at its hard cap instead of running out of pages. */
  paginationComplete: boolean;
}

export function isLibraryScrapeComplete(stats: LibraryScrapeStats): boolean {
  return stats.skippedCount === 0 && stats.paginationComplete;
}

/** A failed archive scrape — distinct from a successful one that found zero books. */
export function failedScrape(): ScrapeResult {
  return { books: [], complete: false };
}

/**
 * Join the library scrape with the archive scrape (`null` = archived books are
 * not synced, so the archive cannot make the result incomplete).
 */
export function combineScrapeResults(
  library: ScrapeResult,
  archive: ScrapeResult | null,
): ScrapeResult {
  if (archive === null) return library;
  return {
    books: [...library.books, ...archive.books],
    complete: library.complete && archive.complete,
  };
}
