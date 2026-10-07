/** Structure layer for `GET /api/family/:id/members` (and, via `sanitizeFamilyMember`, the PATCH member
 *  response): drop unaddressable, normalize the rest. Why: docs/architecture.md → 伺服器回傳資料的檢查. */

import { BoolFlag } from "./types";
import type { ApiResponse, FamilyGroup, FamilyMember } from "./types";

/** Reject primitives, `null`, and arrays; only a plain object can be an element. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep a string as-is; anything else (missing, number, object, `null`) becomes `""`. */
function toStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Keep only an exact `BoolFlag` member; anything else (missing, `true`, `2`, `"1"`) → `undefined`, which
 *  downstream reads as TRUE (`canLend !== BoolFlag.FALSE`) — the compat for Workers predating the field. */
function toBoolFlagField(value: unknown): BoolFlag | undefined {
  if (value === BoolFlag.TRUE) return BoolFlag.TRUE;
  if (value === BoolFlag.FALSE) return BoolFlag.FALSE;
  return undefined;
}

/**
 * Rebuild one element as a trusted `FamilyMember`, or `null` to drop it.
 *
 * The result is a fresh object literal holding at most the 4 interface fields —
 * never a spread of the raw element, so hostile extra properties (including an
 * own `__proto__` key from `JSON.parse`) cannot survive into React state.
 *
 * Exported because the list is not the only door into `members` state: the
 * single member object returned by `PATCH /api/family/:id/member/:uid` is
 * spliced into it verbatim by `updateMember` in
 * `extension/src/dialog/useFamilyDataMembers.ts`, so that client's
 * `updateMemberSettings` puts the payload through the same drop/normalize rules.
 * The drop criterion needs no adjustment there: every consumer of the result
 * already has the `|| userId.slice(0, 8)` fallback a normalized `displayName`
 * relies on. A `null` verdict is handled differently per caller though — one
 * element of a list is dropped silently, a whole PATCH response becomes an
 * `ApiError` the UI can retry. The PWA has no such consumer yet
 * (`pwa/src/components/MemberList.tsx` discards that response and refetches the
 * list), so the export also means a future PWA consumer finds the guard already
 * here.
 */
export function sanitizeFamilyMember(element: unknown): FamilyMember | null {
  if (!isRecord(element)) return null;

  const userId = element.userId;
  if (typeof userId !== "string" || userId === "") return null;

  const canLend = toBoolFlagField(element.canLend);
  const readmooName = element.readmooName;

  return {
    userId,
    displayName: toStringField(element.displayName),
    // Optionals are omitted rather than set to `undefined`: absence is what the
    // two "treat missing as X" fallbacks are written against.
    ...(canLend !== undefined && { canLend }),
    ...(typeof readmooName === "string" && { readmooName }),
  };
}

/** Validate the member list; a malformed container degrades to "no members" with no new error
 *  code, because an unusable list is not something the UI can ask the user to act on. */
function sanitizeFamilyMembers(claimed: unknown): FamilyMember[] {
  if (!Array.isArray(claimed)) {
    console.warn(
      "[memberValidation] malformed members payload: expected an array, treating as empty",
    );
    return [];
  }

  // `Array.isArray` narrows `unknown` to `any[]`; re-type so element access
  // stays checked instead of silently becoming `any`.
  const elements: unknown[] = claimed;
  const members: FamilyMember[] = [];
  for (const element of elements) {
    const member = sanitizeFamilyMember(element);
    if (member !== null) members.push(member);
  }

  // One aggregate warning, never one per element — a hostile payload must not
  // turn into log spam.
  const dropped = elements.length - members.length;
  if (dropped > 0) {
    console.warn(
      `[memberValidation] dropped ${dropped} malformed family member(s)`,
    );
  }
  return members;
}

/**
 * Validate a `GET /api/family/:id/members` envelope at the API boundary.
 *
 * `data.members` is rebuilt, and `apiEndpoint` is normalized to a string or
 * `null` — it is the one pass-through field that reaches a React child, so its
 * declared type has to hold rather than stay a claim. Every other `FamilyGroup`
 * field (`familyId`, `ownerId`, `maxMembers`, `createdAt`, `authToken`,
 * `expiresAt`) passes through exactly as it does today: its consumers do `===`
 * comparisons and `??` fallbacks that are safe for an arbitrary value, and
 * render-side text hardening is a separate layer. The assertion below says that
 * honestly — those fields stay unproven claims, typed for the caller's
 * convenience only.
 */
export function sanitizeFamilyMembersResponse(
  res: ApiResponse<unknown>,
): ApiResponse<FamilyGroup> {
  // Truthiness, not `!== undefined`: a BYO `error: null` would otherwise skip validation;
  // see docs/architecture.md → 伺服器回傳資料的檢查.
  if (res.error || res.data === undefined || res.data === null) {
    return res as ApiResponse<FamilyGroup>;
  }

  // A non-object `data` has no `FamilyGroup` field to pass through: it degrades to a
  // members-only group, whose missing `members` the array check reports.
  const claimed: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const claimedEndpoint = claimed.apiEndpoint;

  return {
    ...res,
    data: {
      ...(claimed as unknown as FamilyGroup),
      members: sanitizeFamilyMembers(claimed.members),
      // The one pass-through field rendered as a React child: any string survives, anything else
      // becomes `null` ("no custom endpoint"). See docs/architecture.md → 伺服器回傳資料的檢查.
      apiEndpoint: typeof claimedEndpoint === "string" ? claimedEndpoint : null,
    },
  };
}
