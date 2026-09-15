/**
 * Runtime boundary validation for `GET /api/family/:id/bookshelf` payloads,
 * applied at the API-client boundary of BOTH apps
 * (`extension/src/api/client.ts`, `pwa/src/api/client.ts`). Sibling of
 * `./memberValidation.ts`, which does the same job for
 * `GET /api/family/:id/members`; the rules live here rather than in either
 * client so the two ends cannot enforce different ones on the same payload.
 *
 * Self-hosted (BYO) backends are inside this project's threat model — a sync
 * code's `@host` segment repoints the whole app at one — so the aggregated
 * bookshelf arrives unvalidated. The TEXT layer (`./entityText.ts` →
 * `sanitizeFamilyBookshelfText`, built on `./safeText.ts`) already coerces every
 * declared-string field to a string, which is what keeps a non-string out of a
 * JSX child or a `.slice(0, 8)` call. This module owns the half coercion cannot
 * fix: a member's `userId` and a book's `bookId` are IDENTITIES, and normalizing
 * an unusable one to `""` KEEPS the element, so two such elements then collide
 * on the empty string. Four observable consequences today, none of them a crash:
 *
 *  1. Duplicate React keys — `key: m.userId` in both member filter dropdowns
 *     (`extension/src/dialog/MemberDropdown.tsx:90`,
 *     `pwa/src/components/MemberDropdown.tsx:81`), and the card key
 *     `` `${memberName}-${bookId}` `` on the book half
 *     (`extension/src/dialog/FamilyShelfBookList.tsx:45`,
 *     `pwa/src/components/FamilyBookList.tsx:66`).
 *  2. An empty member label: both halves of `displayName || userId.slice(0, 8)`
 *     degrade to `""` (`MemberDropdown.tsx:92` / `:83`).
 *  3. Collapsed viewer-private family-shelf preferences — `familyPrefRef` builds
 *     `` `${ownerId}:${bookId}` `` (`extension/src/dialog/familyShelfPrefs.ts:4`,
 *     `pwa/src/hooks/familyShelfPrefs.ts:4`), so hiding or favouriting one
 *     degraded card hits every degraded card — and that collapsed ref is
 *     PERSISTED to the server through `updateFamilyPrefs`.
 *  4. A corrupted update-tracking baseline — `baseline[member.userId]`
 *     (`extension/src/dialog/updateTracking.ts:85`,
 *     `pwa/src/hooks/updateTracking.ts:102`) collapses every degraded member
 *     onto one `""` key, persisted to `chrome.storage.local` / `localStorage`.
 *
 * Hence DROP rather than normalize, for those two identity fields only — the
 * same verdict `sanitizeFamilyMember` reaches for an element that cannot be
 * addressed at all. Every other field is left to the text layer, which runs
 * SECOND (see the composition comment in each client's `getFamilyBookshelf`).
 *
 * Known residual, deliberately NOT closed here: the rule is "usable", not
 * "unique". Two members sharing one non-empty `userId` reproduce consequences
 * 1 and 4 outright, and 3 as soon as those members also share a `bookId`; one
 * member carrying two books with the same `bookId` reproduces 1 and 3. Only
 * consequence 2 is closed outright — an empty label needs `userId === ""`,
 * which no surviving member can carry any more. `./memberValidation.ts`
 * carries the identical residual for the member list, and the official Worker
 * does not deduplicate `bookId` either (`parseBooks` in
 * `worker/src/routes/user.ts`), so a dedup rule would be a policy change on
 * both ends rather than a boundary check; none of these collisions can crash
 * the UI.
 *
 * Parameter and return types are STRUCTURAL and generic, the convention
 * `./entityText.ts` documents for itself: neither app's `FamilyBookshelf`
 * interface is imported here. The two declarations genuinely differ — the PWA's
 * adds `familyId` and a per-member `lastUpdated` — and neither lives in
 * `shared/`; staying structural is what lets ONE module serve both ends.
 *
 * Two deliberate differences from `./memberValidation.ts`:
 *
 *  - A surviving MEMBER is kept by SPREAD (`{ ...element, books }`) instead of
 *    rebuilt as a fresh literal. A rebuild has to enumerate the fields, and the
 *    two ends' member shapes differ as noted above — `lastUpdated` is PWA-only
 *    and is a meaningful tri-state — so a fixed field list would silently drop
 *    it on one end. The hostile-extras risk the rebuild exists to close is
 *    already absent here: both consumers rebuild the member as a fresh 3-field
 *    literal before it reaches React state (`parsedMembers` in
 *    `extension/src/dialog/FamilyDataContext.tsx`, `memberBooks` in
 *    `pwa/src/hooks/useFamilyData.tsx`). Field COERCION stays with the text
 *    layer, which runs second.
 *  - A surviving BOOK passes through completely unchanged. `isShared`,
 *    `isArchived` and `coverUrl` sit outside the text layer's `BookTextFields`
 *    and are load-bearing — `isShared === BoolFlag.TRUE` is the family-shelf
 *    filter itself — so a rebuild here would delete them.
 *
 * The check runs INSIDE the `{ data, error }` envelope, like
 * `sanitizeFamilyMembersResponse`, because both callers read the envelope
 * themselves. An `error` (or data-less) envelope passes through untouched — an
 * auth failure must never be laundered into an empty bookshelf (Invariant 2).
 */

import type { ApiResponse } from "./types";

/** Reject primitives, `null`, and arrays; only a plain object can be an element. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An identity field is usable only as a NON-EMPTY string: `""` is exactly the
 * degraded value the text layer would hand back, and it is what collides.
 */
function hasUsableId(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  return typeof value === "string" && value !== "";
}

/**
 * Book losses, accumulated across every member so one response emits at most
 * ONE aggregate warning for them — never one per element, or a hostile payload
 * becomes log spam. The two counts stay separate because an unusable container
 * hides an unknowable number of books.
 */
interface BookLossTally {
  /** Elements dropped for not being a plain object, or lacking a usable `bookId`. */
  dropped: number;
  /** Members whose `books` was not an array at all, so the whole list became `[]`. */
  unusableLists: number;
}

/**
 * Validate one member's `books`.
 *
 * A malformed container degrades to "no books" rather than throwing, the same
 * policy `sanitizeList` in `./safeText.ts` applies one layer down: an empty
 * shelf is a state the UI already renders.
 */
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

/**
 * Keep one bookshelf member with its `books` replaced, or `null` to drop it.
 *
 * Dropping is the only honest verdict for a member with no usable `userId`: it
 * could serve neither as a React key, nor as the member-name lookup key, nor as
 * the owner half of a family-shelf preference ref.
 */
function sanitizeBookshelfMember(
  element: unknown,
  tally: BookLossTally,
): Record<string, unknown> | null {
  if (!isRecord(element)) return null;
  if (!hasUsableId(element, "userId")) return null;
  return { ...element, books: sanitizeBooks(element.books, tally) };
}

/**
 * Validate the member list itself.
 *
 * A malformed container degrades to "no members" rather than throwing: there is
 * no new error code here, because an unusable bookshelf is not something the UI
 * can ask the user to act on.
 */
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
 * Only `data.members` is rebuilt. Every other top-level field — `familyId` on
 * the PWA side, and anything a future payload adds — passes through by spread:
 * the text layer already coerces `familyId`, and this module owns structure
 * only. The return type is a claim for the caller's convenience, exactly as in
 * `sanitizeFamilyMembersResponse`; what it actually guarantees is that every
 * surviving member has a non-empty string `userId` and an array `books` whose
 * every element has a non-empty string `bookId` — usable, not unique (see the
 * "Known residual" note in the module JSDoc).
 */
export function sanitizeFamilyBookshelfResponse<T>(
  res: ApiResponse<unknown>,
): ApiResponse<T> {
  // Truthiness for `error`, deliberately not `!== undefined`: a BYO backend can
  // send `error: null`, which both callers' own `if (response.error)` reads as
  // success before consuming `data` — waving that envelope through would leave
  // exactly the payload this module exists to check unvalidated. `data` is
  // nullish-checked for the mirror-image reason: nothing downstream reads it.
  if (res.error || res.data === undefined || res.data === null) {
    return res as ApiResponse<T>;
  }

  // A non-object `data` carries no bookshelf field at all, so there is nothing
  // to pass through — it degrades to a members-only payload, and its missing
  // `members` is reported by the array check like any other malformation.
  const claimed: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const tally: BookLossTally = { dropped: 0, unusableLists: 0 };
  const members = sanitizeBookshelfMembers(claimed.members, tally);
  warnBookLosses(tally);

  return {
    ...res,
    data: { ...claimed, members } as unknown as T,
  };
}
