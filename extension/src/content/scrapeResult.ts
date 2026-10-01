/**
 * Completeness of a library scrape — pure rules, no DOM.
 *
 * A scrape is COMPLETE only when it is POSITIVELY known to have seen every
 * book the user owns: Readmoo's own item count for the current view is known
 * and equals the number of cards read, no own book was skipped, pagination did
 * not stop at its hard cap, and (when archived books are synced) the archive
 * scrape is complete too. "Scrolling stopped producing new cards" is NOT such
 * confirmation — a slow next page looks the same. Only a complete scrape may
 * be used to conclude that a saved book is missing from Readmoo (see
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
  /** False when pagination stopped at its hard cap. True does NOT confirm the list's end. */
  belowPageCap: boolean;
  /**
   * Items Readmoo holds for the current view (borrowed-in cards included), as
   * published by the fiber bridge; null when it could not be read.
   */
  listTotal: number | null;
  /** `.library-item` cards in the DOM when the cards were read. */
  itemCount: number;
}

export function isLibraryScrapeComplete(stats: LibraryScrapeStats): boolean {
  return (
    stats.listTotal !== null &&
    stats.itemCount === stats.listTotal &&
    stats.skippedCount === 0 &&
    stats.belowPageCap
  );
}

/** A failed or unconfirmable scrape — never treated as "zero books found". */
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
