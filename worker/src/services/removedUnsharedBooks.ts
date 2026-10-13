/** Server-owned tombstones of books removed from `user:{id}` while NOT shared (#312), computed by
 *  `PUT /api/user/:id/books`. Pure; rule: docs/architecture.md → 個人開放設定 API. */
import { isRealBookId } from "moo-family-bookshelf-shared/api/bookId";
import {
  BoolFlag,
  MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH,
  MAX_REMOVED_UNSHARED_BOOK_IDS,
  type BookEntry,
} from "../kv/schema";

/** A real bookId short enough to list — the length cap bounds the list's bytes, not just its count. */
function isTombstoneId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH &&
    isRealBookId(id)
  );
}

/** Tombstone-id strings of a CAST stored list, deduplicated in order; anything else ⇒ `[]`. */
function normalizeStoredIds(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.filter(isTombstoneId))];
}

/** Tombstone ids of the stored books that were not shared, in stored order. */
function unsharedRealIds(books: unknown): string[] {
  if (!Array.isArray(books)) return [];
  return (books as Partial<BookEntry>[])
    .filter((b) => b && isTombstoneId(b.bookId) && b.isShared !== BoolFlag.TRUE)
    .map((b) => b.bookId as string);
}

/**
 * Next `removedUnsharedBookIds` for a books PUT. Starts from the stored list
 * (normalised: the KV record is cast, not validated), drops every id present
 * in `nextBooks` (the book is back and its own `isShared` carries the choice),
 * then appends — in `existingBooks` order, skipping ids already listed — every
 * real-id book that was stored NOT shared and is absent from `nextBooks`
 * (an id longer than `MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH` is never listed,
 * and such a stored entry is dropped on normalisation).
 * Keeps only the newest `MAX_REMOVED_UNSHARED_BOOK_IDS` entries (oldest
 * first). No time-based expiry: a tombstone only ever keeps a book unshared.
 *
 * The caller stores the field only when the result is non-empty, so a user who
 * never lost an unshared book keeps the old record shape.
 */
export function nextRemovedUnsharedBookIds(
  stored: unknown,
  existingBooks: unknown,
  nextBooks: readonly BookEntry[],
): string[] {
  const nextIds = new Set(nextBooks.map((b) => b.bookId));
  const list = normalizeStoredIds(stored).filter((id) => !nextIds.has(id));
  const listed = new Set(list);
  for (const id of unsharedRealIds(existingBooks)) {
    if (nextIds.has(id) || listed.has(id)) continue;
    list.push(id);
    listed.add(id);
  }
  return list.slice(-MAX_REMOVED_UNSHARED_BOOK_IDS);
}
