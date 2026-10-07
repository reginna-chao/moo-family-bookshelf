/** Structure layer for `GET /api/family/:id/bookshelf` (runs before the text layer): drops members and
 *  books without a usable id. Why, and the known residuals: docs/architecture.md → 伺服器回傳資料的檢查. */

import type { ApiResponse } from "./types";

/** Reject primitives, `null`, and arrays; only a plain object can be an element. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An identity field is usable only as a NON-EMPTY string: `""` is exactly the degraded
 *  value the text layer would hand back, and it is what collides. */
function hasUsableId(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  return typeof value === "string" && value !== "";
}

/** Book losses tallied across ALL members, so one response logs at most one aggregate warning; the
 *  counts stay apart because an unusable container hides an unknowable number of books. */
interface BookLossTally {
  /** Elements dropped for not being a plain object, or lacking a usable `bookId`. */
  dropped: number;
  /** Members whose `books` was not an array at all, so the whole list became `[]`. */
  unusableLists: number;
}

/** Validate one member's `books`; a malformed container degrades to "no books" (the policy of
 *  `sanitizeList` in `./safeText.ts`) — an empty shelf is a state the UI already renders. */
function sanitizeBooks(claimed: unknown, tally: BookLossTally): unknown[] {
  if (!Array.isArray(claimed)) {
    tally.unusableLists += 1;
    return [];
  }

  // `Array.isArray` narrows `unknown` to `any[]`; re-type so element access
  // stays checked instead of silently becoming `any`.
  const elements: unknown[] = claimed;
  const books = elements.filter(
    (element) => isRecord(element) && hasUsableId(element, "bookId"),
  );
  tally.dropped += elements.length - books.length;
  return books;
}

/** Keep one member with its `books` replaced, or `null` to drop it: without a usable `userId` it is
 *  neither a React key, the member-name lookup key, nor the owner half of a pref ref. */
function sanitizeBookshelfMember(
  element: unknown,
  tally: BookLossTally,
): Record<string, unknown> | null {
  if (!isRecord(element)) return null;
  if (!hasUsableId(element, "userId")) return null;
  return { ...element, books: sanitizeBooks(element.books, tally) };
}

/** Validate the member list; a malformed container degrades to "no members" with no new error
 *  code, because an unusable bookshelf is not something the UI can ask the user to act on. */
function sanitizeBookshelfMembers(
  claimed: unknown,
  tally: BookLossTally,
): Record<string, unknown>[] {
  if (!Array.isArray(claimed)) {
    console.warn(
      "[bookshelfValidation] malformed members payload: expected an array, treating as empty",
    );
    return [];
  }

  const elements: unknown[] = claimed;
  const members: Record<string, unknown>[] = [];
  for (const element of elements) {
    const member = sanitizeBookshelfMember(element, tally);
    if (member !== null) members.push(member);
  }

  // One aggregate warning, never one per element. Mutually exclusive with the
  // container warning above, so the member half costs at most one line.
  const dropped = elements.length - members.length;
  if (dropped > 0) {
    console.warn(
      `[bookshelfValidation] dropped ${dropped} malformed family member(s)`,
    );
  }
  return members;
}

/** The second and last aggregate warning; silent when nothing was lost. */
function warnBookLosses(tally: BookLossTally): void {
  if (tally.dropped === 0 && tally.unusableLists === 0) return;
  console.warn(
    `[bookshelfValidation] dropped ${tally.dropped} malformed book(s); ` +
      `${tally.unusableLists} member(s) had an unusable books list`,
  );
}

/**
 * Validate a `GET /api/family/:id/bookshelf` envelope at the API boundary.
 *
 * Only `data.members` is rebuilt. Every other top-level field — `familyId`,
 * and anything a future payload adds — passes through by spread:
 * the text layer already coerces `familyId`, and this module owns structure
 * only. The return type is a claim for the caller's convenience, exactly as in
 * `sanitizeFamilyMembersResponse`; what it actually guarantees is that every
 * surviving member has a non-empty string `userId` and an array `books` whose
 * every element has a non-empty string `bookId` — usable, not unique (see
 * docs/architecture.md → 伺服器回傳資料的檢查).
 */
export function sanitizeFamilyBookshelfResponse<T>(
  res: ApiResponse<unknown>,
): ApiResponse<T> {
  // Truthiness, not `!== undefined`: a BYO `error: null` would otherwise skip validation;
  // see docs/architecture.md → 伺服器回傳資料的檢查.
  if (res.error || res.data === undefined || res.data === null) {
    return res as ApiResponse<T>;
  }

  // A non-object `data` has nothing to pass through: it degrades to a members-only
  // payload, whose missing `members` the array check reports.
  const claimed: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const tally: BookLossTally = { dropped: 0, unusableLists: 0 };
  const members = sanitizeBookshelfMembers(claimed.members, tally);
  warnBookLosses(tally);

  return {
    ...res,
    data: { ...claimed, members } as unknown as T,
  };
}
