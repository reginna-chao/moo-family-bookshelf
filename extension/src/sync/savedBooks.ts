import type { ApiResponse, BookEntry } from "../api/client";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";

export interface LoadSavedResult {
  books: BookEntry[];
  /** Full payload — preserved so a later PUT can spread back unknown fields; null = no usable record. */
  raw: Record<string, unknown> | null;
}

/** Fallback copy when a failed read of the saved list carries no usable message. */
export const SAVED_BOOKS_READ_FAILED_MESSAGE = "讀取書單失敗，請稍後再試";

/**
 * Read the `books` list out of a `GET /api/user/:id/books` `data` value
 * (plaintext JSON). Anything without a `books` array counts as no record.
 */
export function loadSavedBooks(data: unknown): LoadSavedResult {
  if (!data || typeof data !== "object") return { books: [], raw: null };
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.books)) return { books: [], raw: null };
  return { books: record.books as BookEntry[], raw: record };
}

/**
 * The saved list a sync is about to upload over. A FAILED read (5xx / 429 /
 * network — `getPersonalBooks` returns `{ error }`, it does not throw) throws,
 * so the caller aborts before any upload: treating it as "no record" would PUT
 * the bare scrape, resetting every share flag and dropping server-only books.
 * A missing record (`data: null`, no `error`) is a first sync and loads empty.
 */
export function loadSavedBooksForSync(
  response: ApiResponse<unknown>,
): LoadSavedResult {
  if (response.error) {
    throw new Error(
      safeErrorText(response.error.message, SAVED_BOOKS_READ_FAILED_MESSAGE),
    );
  }
  return loadSavedBooks(response.data);
}
