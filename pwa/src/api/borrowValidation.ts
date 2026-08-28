/**
 * Runtime boundary validation for `GET /api/family/:id/borrow` payloads.
 *
 * Self-hosted (BYO) backends are inside this project's threat model, so the
 * borrow list arrives unvalidated: a non-string `createdAt` crashes
 * `sortNewestFirst`'s `localeCompare` inside a parent-level `useMemo` (before
 * any card mounts), a non-string `borrowerId` / `ownerId` crashes `.slice`, and
 * React throws outright when an object is rendered as a child.
 *
 * Two failure modes, deliberately handled differently:
 * - DROP the element when it cannot be addressed at all (not an object, or no
 *   usable `requestId` — it could serve neither as a React key nor as the
 *   target of `PATCH /api/borrow/:id`).
 * - NORMALIZE every other field to `""` when it is not a string, because each
 *   downstream consumer already has a `||` fallback and `""` is safe for both
 *   `localeCompare` and `.slice`.
 *
 * Kept in sync with `extension/src/api/borrowValidation.ts` — the two ends
 * deliberately stay separate copies (no `shared/` module), mirroring the
 * PR #132 convention.
 *
 * The types come from `./client`, which imports this module back; `import type`
 * keeps that cycle type-only, so it is erased at compile time.
 */

import type { BorrowRequest, BorrowStatus } from "./client";

/** Reject primitives, `null`, and arrays; only a plain object can be an element. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep a string as-is; anything else (missing, number, object, `null`) becomes `""`. */
function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Rebuild one element as a trusted `BorrowRequest`, or `null` to drop it.
 *
 * The result is a fresh object literal holding exactly the 12 interface fields —
 * never a spread of the raw element, so hostile extra properties cannot survive
 * into React state.
 */
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
    // `status` passes through unvalidated ON PURPOSE. Unknown-status handling is
    // owned by the render side (the `default:` branch of `getStatusStyle` in
    // `components/BorrowCard.tsx`), and every comparison performed on it here
    // and downstream (`===`) is safe for an arbitrary value.
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
