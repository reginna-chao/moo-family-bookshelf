/** The server's per-book text caps applied to a scrape before `mergeBooks` (#326): the Worker refuses the
 *  WHOLE `PUT /api/user/:id/books` when one entry is over a cap, so one over-long book must not block a sync. */

import {
  BOOK_TEXT_FIELD_LIMITS,
  BOOK_TITLE_MAX_LENGTH,
  exceedsBookFieldCap,
  overCapBookField,
} from "moo-family-bookshelf-shared/api/bookFieldLimits";
import type { BookEntry } from "../api/client";
import type { ScrapedBook } from "../content/scraper";
import { titleKey } from "./legacyBooks";

export interface FieldCapFit {
  /** The scrape to merge — the input array itself when every book fits. */
  books: ScrapedBook[];
  /** Books new to the server left out this sync: those whose scraped title is over its cap. */
  skippedCount: number;
  /** Non-empty `titleKey`s of the left-out books: each still counts as present for same-title matching,
   *  so it keeps such matches ambiguous and the saved book it may replace unpruned. */
  skippedTitles: ReadonlySet<string>;
  /** Books new to the server uploaded with each over-cap author / category sent as `""`. Each book
   *  counts once. */
  blankedCount: number;
  /** Saved books sent with an over-cap field fitted: a title replaced by the placeholder, an author
   *  or a category replaced by the stored value. Each book counts once. */
  keptStoredCount: number;
}

/**
 * The title sent for every saved book whose scraped title is over the cap,
 * renamed or not. A fixed value, not a cut: a cut (or the stored title) can
 * equal another book's title, and same-title matching would then move that
 * entry's share flag onto this book. Only saved books ever carry the
 * placeholder — a new over-cap book is left out and legacy entries predate
 * it — so same-title matching never pairs on it.
 */
export const OVER_CAP_TITLE_PLACEHOLDER = "（書名太長，無法顯示）";

/** A stored text value as sent back; the saved list is an unvalidated cast, so a non-string is `""`. */
function storedText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A saved book as sent: an over-cap title becomes `OVER_CAP_TITLE_PLACEHOLDER`; an over-cap author / category
 *  takes the stored value, sent as-is even when over the cap (the Worker admits it unchanged). */
function fitSavedBook(book: ScrapedBook, stored: BookEntry): ScrapedBook {
  if (overCapBookField(book) === null) return book;
  const fitted = { ...book };
  for (const [field, max] of BOOK_TEXT_FIELD_LIMITS) {
    if (field === "isbn" || !exceedsBookFieldCap(book[field], max)) continue; // isbn: never scraped
    fitted[field] =
      field === "title"
        ? OVER_CAP_TITLE_PLACEHOLDER
        : storedText(stored[field]);
  }
  return fitted;
}

/** A new book whose title fits, with each over-cap author / category sent as `""`. Returns `book`
 *  itself when no field is over its cap. */
function withBlankedFields(book: ScrapedBook): ScrapedBook {
  if (overCapBookField(book) === null) return book;
  const fitted = { ...book };
  for (const [field, max] of BOOK_TEXT_FIELD_LIMITS) {
    if (field !== "author" && field !== "category") continue;
    if (exceedsBookFieldCap(book[field], max)) fitted[field] = "";
  }
  return fitted;
}

/**
 * Fit a scrape to the server's text-field caps (`BOOK_TEXT_FIELD_LIMITS`). A
 * book NOT in `saved` whose title is over `BOOK_TITLE_MAX_LENGTH` is left out:
 * it is new to the server, so leaving it out records nothing as removed. Only
 * the title decides this, because scraped titles are trimmed (`extractTitle`)
 * and the Worker accepts no new over-cap title, so such a title equals no
 * stored one and leaving the book out never changes how many real books carry
 * any title the same-title steps (`mergeBooks`, `resolveForUpload`) can match.
 * Any other new book is uploaded, each over-cap author or category sent as
 * `""`: a book missing from the shelf is worse than a missing author, and
 * neither field takes part in matching. A book in `saved` is never left out
 * (a full PUT without it would record it as removed and lose its share flag):
 * an over-cap author or category takes the saved value instead. An over-cap
 * title, changed or not, is replaced by `OVER_CAP_TITLE_PLACEHOLDER`: a cut or
 * the saved title could equal another book's title and move its share flag;
 * the placeholder never pairs. A saved book NOT scraped this sync keeps its
 * stored title, which may predate the caps and be over them; so a legacy entry
 * with an over-cap title never resolves onto a real book, at sync or at load
 * (`dropResolvedLegacyBooks` in `legacyBooks.ts`) — less sharing, never more.
 * Every other field still comes from the scrape; nothing is truncated.
 * A left-out book's title is reported in `skippedTitles` for the same-title
 * steps: it keeps a saved book with that stored title from being pruned as
 * removed, and keeps a same-title match ambiguous on that sync.
 * Order is preserved, neither input is mutated, and `scraped` itself is
 * returned (with an empty `skippedTitles`) when every book fits. Pure; the caller logs (`warnFieldCapFit`).
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
      blankedCount: 0,
      keptStoredCount: 0,
    };
  }
  const savedById = new Map(saved.map((entry) => [entry.bookId, entry]));
  const books: ScrapedBook[] = [];
  const skippedTitles = new Set<string>();
  let blankedCount = 0;
  let keptStoredCount = 0;
  for (const book of scraped) {
    const stored = savedById.get(book.bookId);
    if (stored) {
      const fitted = fitSavedBook(book, stored);
      if (fitted !== book) keptStoredCount += 1;
      books.push(fitted);
    } else if (exceedsBookFieldCap(book.title, BOOK_TITLE_MAX_LENGTH)) {
      const key = titleKey(book);
      if (key !== "") skippedTitles.add(key);
    } else {
      const fitted = withBlankedFields(book);
      if (fitted !== book) blankedCount += 1;
      books.push(fitted);
    }
  }
  // Only a new book with an over-cap title is left out, so every missing book is one of those.
  return {
    books,
    skippedCount: scraped.length - books.length,
    skippedTitles,
    blankedCount,
    keptStoredCount,
  };
}

/** One counts-only warning (never a title or author) when `fit` left out, blanked or kept-stored any book. */
export function warnFieldCapFit(fit: FieldCapFit): void {
  if (
    fit.skippedCount === 0 &&
    fit.blankedCount === 0 &&
    fit.keptStoredCount === 0
  ) {
    return;
  }
  console.warn("[moo] books over the server's text-field caps", {
    skippedCount: fit.skippedCount,
    blankedCount: fit.blankedCount,
    keptStoredCount: fit.keptStoredCount,
  });
}
