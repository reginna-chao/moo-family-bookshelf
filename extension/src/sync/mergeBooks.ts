import { BookEntry, BoolFlag } from "../api/client";
import { ScrapedBook } from "../content/scraper";
import { dropResolvedLegacyBooks } from "./legacyBooks";

/**
 * Merge scraped books with saved book entries.
 * - Books in both: use scraped metadata, keep saved isShared setting
 * - Scraped-only: default isShared = 0
 * - Saved-only: keep as-is (user may be on a different page), EXCEPT
 *   legacy entries resolved to a real one, which are dropped by
 *   `dropResolvedLegacyBooks` (#234); ids in `keepFlagsFor` (the user's
 *   unsaved toggles) are never promoted by that step
 */
export function mergeBooks(
  scraped: ScrapedBook[],
  saved: BookEntry[],
  keepFlagsFor?: ReadonlySet<string>,
): BookEntry[] {
  const savedMap = new Map(saved.map((b) => [b.bookId, b]));
  const merged = new Map<string, BookEntry>();

  for (const book of scraped) {
    const existing = savedMap.get(book.bookId);
    merged.set(book.bookId, {
      bookId: book.bookId,
      title: book.title,
      author: book.author || existing?.author || "",
      isbn: existing?.isbn || "",
      coverUrl: book.coverUrl || existing?.coverUrl || "",
      readmooUrl: book.readmooUrl,
      category: book.category || existing?.category || "",
      isShared: existing?.isShared ?? BoolFlag.FALSE,
      isArchived: book.isArchived ?? existing?.isArchived ?? BoolFlag.FALSE,
    });
  }

  for (const book of saved) {
    if (!merged.has(book.bookId)) {
      merged.set(book.bookId, book);
    }
  }

  return dropResolvedLegacyBooks(Array.from(merged.values()), keepFlagsFor);
}
