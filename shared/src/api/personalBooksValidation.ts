/** Structure layer for `GET /api/user/:id/books` (runs before the text layer): coerces each book's
 *  `BoolFlag` fields and never drops a book. Why: docs/architecture.md → 伺服器回傳資料的檢查. */

import { BoolFlag } from "./types";
import type { ApiResponse } from "./types";

/** Reject primitives, `null`, and arrays; only a plain object can be an element. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolFlag(value: unknown): value is BoolFlag {
  return value === BoolFlag.TRUE || value === BoolFlag.FALSE;
}

/** Exactly `1` is shared; anything else (`true`, `"1"`, `2`, missing) is not — default closed, the
 *  same rule as the Worker's own `toBoolFlag`. */
function toIsShared(value: unknown): BoolFlag {
  return value === BoolFlag.TRUE ? BoolFlag.TRUE : BoolFlag.FALSE;
}

/** Keep only an exact `BoolFlag` member; anything else → `undefined`, so the key is omitted and the
 *  book reads as active (`mergeBooks` falls back to the saved value, then `BoolFlag.FALSE`). */
function toIsArchived(value: unknown): BoolFlag | undefined {
  return isBoolFlag(value) ? value : undefined;
}

/** Flag values that are not an exact `BoolFlag`: a missing `isShared` counts (the schema requires
 *  it), a missing `isArchived` does not (absent means active). */
function countCoercedFlags(book: Record<string, unknown>): number {
  let coerced = isBoolFlag(book.isShared) ? 0 : 1;
  if (book.isArchived !== undefined && !isBoolFlag(book.isArchived)) {
    coerced += 1;
  }
  return coerced;
}

/** Rebuild one plain-object book with coerced flags; any other element passes through untouched
 *  (the text layer's `sanitizeList` owns dropping those). */
function sanitizeBookFlags(
  element: unknown,
  tally: { coerced: number },
): unknown {
  if (!isRecord(element)) return element;

  tally.coerced += countCoercedFlags(element);
  // The raw `isArchived` must not survive the spread: an unusable value is omitted, not kept.
  const { isArchived: claimedArchived, ...rest } = element;
  const isArchived = toIsArchived(claimedArchived);
  // Spread on purpose: the full-PUT save sends unknown book fields back to the server, so every
  // field this layer does not own must pass through (docs/architecture.md → 伺服器回傳資料的檢查).
  return {
    ...rest,
    isShared: toIsShared(element.isShared),
    ...(isArchived !== undefined && { isArchived }),
  };
}

/**
 * Validate a `GET /api/user/:id/books` envelope at the API boundary.
 *
 * Only the flag VALUES of plain-object elements of `data.books` change:
 * `isShared` becomes `BoolFlag.TRUE` for exactly `1` and `BoolFlag.FALSE` for
 * anything else, and `isArchived` is kept only as an exact `BoolFlag` member,
 * otherwise omitted. No element is ever dropped or reordered and no `bookId` is
 * touched — the next full PUT replaces the server's list with the client's, so
 * a book dropped here would be deleted from the server. Every other field of
 * `data` passes through by spread. A non-object `data` or a non-array `books`
 * is returned untouched: the text layer and `loadSavedBooks` own those
 * degradations. At most one aggregate `console.warn` per response.
 */
export function sanitizePersonalBooksResponse<T>(
  res: ApiResponse<unknown>,
): ApiResponse<T> {
  // Truthiness, not `!== undefined`: a BYO `error: null` would otherwise skip validation;
  // see docs/architecture.md → 伺服器回傳資料的檢查.
  if (res.error || res.data === undefined || res.data === null) {
    return res as ApiResponse<T>;
  }

  const data = res.data;
  if (!isRecord(data) || !Array.isArray(data.books)) {
    return res as ApiResponse<T>;
  }

  // `Array.isArray` narrows to `any[]`; re-type so element access stays checked.
  const elements: unknown[] = data.books;
  const tally = { coerced: 0 };
  const books = elements.map((element) => sanitizeBookFlags(element, tally));

  // One aggregate warning, never one per element, and never the values themselves.
  if (tally.coerced > 0) {
    console.warn(
      `[personalBooksValidation] coerced ${tally.coerced} book flag value(s) that were not an exact BoolFlag`,
    );
  }

  return {
    ...res,
    data: { ...data, books } as unknown as T,
  };
}
