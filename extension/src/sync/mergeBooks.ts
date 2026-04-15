import { BookEntry, BoolFlag } from "../api/client";
import { ScrapedBook } from "../content/scraper";

/**
 * Branded type: BookEntry[] that came from a successful decrypt or a
 * verified in-memory source. mergeBooks() requires this type for the
 * `saved` parameter so that passing a raw `[]` (e.g. from a catch
 * block on decrypt failure) is a compile-time error.
 */
declare const __decryptedBrand: unique symbol;
export type DecryptedBooks = BookEntry[] & { readonly [__decryptedBrand]: true };

/**
 * Tag a BookEntry[] as DecryptedBooks. Only use this when the books
 * are known to originate from a successful decrypt or are already
 * loaded in trusted in-memory state (e.g. React component state that
 * was itself populated from a prior decrypt).
 */
export function asDecryptedBooks(books: BookEntry[]): DecryptedBooks {
  return books as DecryptedBooks;
}

/**
 * Merge scraped books with saved book entries.
 * - Books in both: use scraped metadata, keep saved isShared setting
 * - Scraped-only: default isShared = 0
 * - Saved-only: keep as-is (user may be on a different page)
 *
 * `saved` must be DecryptedBooks to prevent accidental merge with
 * empty fallback data from a failed decrypt (see security-ux-invariants).
 */
export function mergeBooks(
  scraped: ScrapedBook[],
  saved: DecryptedBooks,
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

  return Array.from(merged.values());
}
