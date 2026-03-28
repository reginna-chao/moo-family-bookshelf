import { BookEntry } from "../api/client";
import { ScrapedBook } from "../content/scraper";

/**
 * Merge scraped books with saved book entries.
 * - Books in both: use scraped metadata, keep saved isShared setting
 * - Scraped-only: default isShared = false
 * - Saved-only: keep as-is (user may be on a different page)
 */
export function mergeBooks(
  scraped: ScrapedBook[],
  saved: BookEntry[],
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
      isShared: existing?.isShared ?? false,
    });
  }

  for (const book of saved) {
    if (!merged.has(book.bookId)) {
      merged.set(book.bookId, book);
    }
  }

  return Array.from(merged.values());
}
