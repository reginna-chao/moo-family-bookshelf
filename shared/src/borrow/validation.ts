/** Structure layer for `GET /api/family/:id/borrow` (drop unaddressable, normalize the rest); the
 *  `[borrowValidation]` prefix is test-asserted. Why: docs/architecture.md → 伺服器回傳資料的檢查. */

import type { BorrowRequest, BorrowStatus } from "./types";

/** Reject primitives, `null`, and arrays; only a plain object can be an element. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep a string as-is; anything else (missing, number, object, `null`) becomes `""`. */
function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Rebuild one element as a trusted `BorrowRequest` (a fresh literal of exactly the 12 fields, never
 *  a spread, so hostile extras cannot reach React state), or `null` to drop it. */
function sanitizeBorrowRequest(element: unknown): BorrowRequest | null {
  if (!isRecord(element)) return null;

  const requestId = element.requestId;
  if (typeof requestId !== "string" || requestId === "") return null;

  return {
    requestId,
    familyId: toStringField(element.familyId),
    borrowerId: toStringField(element.borrowerId),
    borrowerName: toStringField(element.borrowerName),
    ownerId: toStringField(element.ownerId),
    bookId: toStringField(element.bookId),
    bookTitle: toStringField(element.bookTitle),
    bookAuthor: toStringField(element.bookAuthor),
    bookCoverUrl: toStringField(element.bookCoverUrl),
    // Unvalidated ON PURPOSE: each app's render side handles an unknown status, and every
    // comparison on it (`Set.has`, `===`) is safe for any value. See docs/architecture.md → 伺服器回傳資料的檢查.
    status: element.status as BorrowStatus,
    createdAt: toStringField(element.createdAt),
    updatedAt: toStringField(element.updatedAt),
  };
}

/**
 * Validate a borrow-list payload at the API boundary.
 *
 * A malformed container degrades to "no requests" rather than throwing: there is
 * no new error code here, because an unusable list is not something the UI can
 * ask the user to act on.
 */
export function sanitizeBorrowRequests(data: unknown): BorrowRequest[] {
  if (!Array.isArray(data)) {
    console.warn(
      "[borrowValidation] malformed borrow payload: expected an array, treating as empty",
    );
    return [];
  }

  // `Array.isArray` narrows `unknown` to `any[]`; re-type so element access
  // stays checked instead of silently becoming `any`.
  const elements: unknown[] = data;
  const requests: BorrowRequest[] = [];
  for (const element of elements) {
    const request = sanitizeBorrowRequest(element);
    if (request !== null) requests.push(request);
  }

  // One aggregate warning, never one per element — a hostile payload must not
  // turn into log spam.
  const dropped = elements.length - requests.length;
  if (dropped > 0) {
    console.warn(
      `[borrowValidation] dropped ${dropped} malformed borrow request(s)`,
    );
  }
  return requests;
}
