import type { BookEntry } from "../api/client";

/**
 * Serialise the personal-books cache. The cache belongs to exactly one
 * account, so its owner's userId is stored alongside the books.
 */
export function encodePersonalBooksCache(
  userId: string,
  books: BookEntry[],
): string {
  return JSON.stringify({ userId, books });
}

/**
 * Return the cached books only when the cache provably belongs to `userId`.
 * Bad JSON, the legacy bare-array format, or a missing / different owner
 * yields `null`: a cache that is not this account's must never be used.
 */
export function readOwnedCachedBooks(
  raw: string,
  userId: string,
): BookEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.userId !== "string" || record.userId !== userId) {
    return null;
  }
  if (!Array.isArray(record.books)) return null;
  return record.books as BookEntry[];
}
