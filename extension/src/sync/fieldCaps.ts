/** The server's per-book text caps applied to a scrape before `mergeBooks` (#326): the Worker refuses the
 *  WHOLE `PUT /api/user/:id/books` when one entry is over a cap, so one over-long book must not block a sync. */

import {
  BOOK_TEXT_FIELD_LIMITS,
  exceedsBookFieldCap,
  overCapBookField,
} from "moo-family-bookshelf-shared/api/bookFieldLimits";
import type { BookEntry } from "../api/client";
import type { ScrapedBook } from "../content/scraper";
import { titleKey } from "./legacyBooks";

export interface FieldCapFit {
  /** The scrape to merge — the input array itself when every book fits. */
  books: ScrapedBook[];
  /** Books new to the server left out this sync: those with a scraped field over its cap, plus
   *  each new book held back for sharing a title with one of them. */
  skippedCount: number;
  /** Non-empty `titleKey`s of the over-cap left-out books: each still counts as present for same-title
   *  matching, so it keeps such matches ambiguous and the saved book it may replace unpruned. */
  skippedTitles: ReadonlySet<string>;
  /** Saved books sent with a stored value: in place of each over-cap scraped field, or of a scraped
   *  title that changed to or away from one in `skippedTitles`. Each book counts once. */
  keptStoredCount: number;
}

/** A stored text value as sent back; the saved list is an unvalidated cast, so a non-string is `""`. */
function storedText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `book` with each over-cap scraped field replaced by the stored entry's value, sent as-is even when
 *  over the cap: the Worker admits an unchanged stored value for its bookId; a cut one breaks matching. */
function withStoredFields(book: ScrapedBook, stored: BookEntry): ScrapedBook {
  const fitted = { ...book };
  for (const [field, max] of BOOK_TEXT_FIELD_LIMITS) {
    if (field === "isbn") continue; // never scraped
    if (exceedsBookFieldCap(book[field], max)) {
      fitted[field] = storedText(stored[field]);
    }
  }
  return fitted;
}

/** A saved book as sent: over-cap fields take the stored values; a scraped title changed to or away from
 *  a held one (`skippedTitles`) takes the stored title. Returns `book` itself when nothing was replaced. */
function fitSavedBook(
  book: ScrapedBook,
  stored: BookEntry,
  skippedTitles: ReadonlySet<string>,
): ScrapedBook {
  const fitted =
    overCapBookField(book) === null ? book : withStoredFields(book, stored);
  const key = titleKey(fitted);
  const storedKey = titleKey(stored);
  if (
    key === storedKey ||
    (!skippedTitles.has(key) && !skippedTitles.has(storedKey))
  ) {
    return fitted;
  }
  return { ...fitted, title: storedText(stored.title) };
}

/** Non-empty `titleKey`s of the books new to the server that have an over-cap field. */
function overCapNewTitles(
  scraped: ScrapedBook[],
  savedById: ReadonlyMap<string, BookEntry>,
): Set<string> {
  const titles = new Set<string>();
  for (const book of scraped) {
    if (savedById.has(book.bookId) || overCapBookField(book) === null) continue;
    const key = titleKey(book);
    if (key !== "") titles.add(key);
  }
  return titles;
}

/**
 * Fit a scrape to the server's text-field caps (`BOOK_TEXT_FIELD_LIMITS`). A
 * book NOT in `saved` with an over-cap field is left out: it is new to the
 * server, so leaving it out records nothing as removed. Every other new book
 * with the same title waits with it, because a lone real twin on the server is
 * what a saved legacy entry resolves onto when the Personal Shelf loads
 * (`usePersonalBooks.ts`), moving its share flag to a book never chosen. A
 * book in `saved` is never left out (a full PUT without it would record it as
 * removed and lose its share flag); each over-cap field takes the saved value
 * instead, every other field still comes from the scrape. For the same reason
 * as the held twins, a saved book whose scraped title changed to or away from
 * a held one keeps its stored title, so no saved book gains or loses that
 * title on the server while a same-title book is held. Nothing is ever
 * truncated. A left-out over-cap book's title is reported in `skippedTitles`
 * for the same-title steps (`mergeBooks`, `resolveForUpload`). Order is
 * preserved, neither input is mutated, and `scraped` itself is returned (with
 * an empty `skippedTitles`) when every book fits. Pure; the caller logs
 * (`warnFieldCapFit`).
 */
export function fitScrapeToFieldCaps(
  scraped: ScrapedBook[],
  saved: readonly BookEntry[],
): FieldCapFit {
  if (scraped.every((book) => overCapBookField(book) === null)) {
    return {
      books: scraped,
      skippedCount: 0,
      skippedTitles: new Set(),
      keptStoredCount: 0,
    };
  }
  const savedById = new Map(saved.map((entry) => [entry.bookId, entry]));
  const skippedTitles = overCapNewTitles(scraped, savedById);
  const books: ScrapedBook[] = [];
  let keptStoredCount = 0;
  for (const book of scraped) {
    const stored = savedById.get(book.bookId);
    if (stored) {
      const fitted = fitSavedBook(book, stored, skippedTitles);
      if (fitted !== book) keptStoredCount += 1;
      books.push(fitted);
    } else if (
      overCapBookField(book) === null &&
      !skippedTitles.has(titleKey(book))
    ) {
      books.push(book);
    }
  }
  // Saved books are never left out, so every missing book is a new one held back.
  return {
    books,
    skippedCount: scraped.length - books.length,
    skippedTitles,
    keptStoredCount,
  };
}

/** One counts-only warning (never a title or author) when `fit` left out or kept-stored any book. */
export function warnFieldCapFit(fit: FieldCapFit): void {
  if (fit.skippedCount === 0 && fit.keptStoredCount === 0) return;
  console.warn("[moo] books over the server's text-field caps", {
    skippedCount: fit.skippedCount,
    keptStoredCount: fit.keptStoredCount,
  });
}
