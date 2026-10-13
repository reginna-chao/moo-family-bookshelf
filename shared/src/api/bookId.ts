/**
 * Longest real book id accepted. Real Readmoo ids are 15 digits; the bound
 * keeps every storable id representable in a familyShelfPrefs ref
 * `"{ownerId}:{bookId}"` and in the removed-unshared tombstone list (#316).
 */
export const MAX_BOOK_ID_LENGTH = 32;

/** Shape of a real Readmoo book id: 12–32 digits (in practice 15). Single source of truth for the Extension scraper, the Extension's legacy-entry cleanup, and the Worker's PUT books boundary. */
export const REAL_BOOK_ID_PATTERN = new RegExp(
  `^\\d{12,${MAX_BOOK_ID_LENGTH}}$`,
);

/** True iff `id` is a string shaped like a real Readmoo book id. */
export function isRealBookId(id: unknown): boolean {
  return typeof id === "string" && REAL_BOOK_ID_PATTERN.test(id);
}
