/** Shape of a real Readmoo book id: 12+ digits (in practice 15). Single source of truth for the Extension scraper, the Extension's legacy-entry cleanup, and the Worker's PUT books boundary. */
export const REAL_BOOK_ID_PATTERN = /^\d{12,}$/;

/** True iff `id` is a string shaped like a real Readmoo book id. */
export function isRealBookId(id: unknown): boolean {
  return typeof id === "string" && REAL_BOOK_ID_PATTERN.test(id);
}
