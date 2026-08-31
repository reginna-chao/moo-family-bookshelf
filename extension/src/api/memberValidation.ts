/**
 * Runtime boundary validation for `GET /api/family/:id/members` payloads, and —
 * through the exported `sanitizeFamilyMember` — for the single member object
 * returned by `PATCH /api/family/:id/member/:uid`.
 *
 * Self-hosted (BYO) backends are inside this project's threat model, so the
 * member list arrives unvalidated: a non-string `userId` crashes `.slice(0, 8)`
 * in `buildOwnerNameLookup` — a parent-level `useMemo` in `dialog/BorrowTab.tsx`
 * that runs before any card mounts — and React throws outright when an
 * object-valued `displayName` is rendered as a child. Neither end has an
 * ErrorBoundary, so a single malformed element takes the whole Dialog down.
 *
 * Two failure modes, deliberately handled differently:
 * - DROP the element when it cannot be addressed at all (not a plain object, or
 *   no usable `userId` — it could serve neither as a React key, nor as the key
 *   of either name lookup, nor as the `:uid` target of `updateMemberSettings` /
 *   `removeMember`).
 * - NORMALIZE what survives: `displayName` becomes `""` when it is not a string,
 *   because every consumer already has a `|| userId.slice(0, 8)` fallback; the
 *   two optional fields are OMITTED unless they carry their declared type, so
 *   the documented "missing `canLend` means TRUE" and the "尚未記錄" hint keep
 *   their backward-compatible meaning.
 *
 * The check runs INSIDE the `{ data, error }` envelope rather than on unwrapped
 * data, because every `getFamilyMembers` caller reads the envelope itself. An
 * `error` (or data-less) envelope passes through untouched — an auth failure
 * must never be laundered into an empty member list (Invariant 2).
 *
 * Kept in sync with `pwa/src/api/memberValidation.ts` — the two ends
 * deliberately stay separate copies (no `shared/` module), mirroring the
 * PR #132 convention.
 */

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

/**
 * Keep a value only when it is exactly one of the two `BoolFlag` members;
 * anything else (missing, `true`, `2`, `"1"`) becomes `undefined`.
 *
 * `undefined` loses nothing: downstream already reads missing as TRUE
 * (`canLend !== BoolFlag.FALSE`), which is the backward-compat semantics for
 * Workers predating the field.
 */
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
 * spliced into it verbatim by `updateMember` in `dialog/FamilyDataContext.tsx`,
 * so `client.ts`'s `updateMemberSettings` puts that payload through the same
 * drop/normalize rules. The drop criterion needs no adjustment there: every
 * consumer of the result already has the `|| userId.slice(0, 8)` fallback a
 * normalized `displayName` relies on. A `null` verdict is handled differently
 * per caller though — one element of a list is dropped silently, a whole PATCH
 * response becomes an `ApiError` the UI can retry.
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

/**
 * Validate the member list itself.
 *
 * A malformed container degrades to "no members" rather than throwing: there is
 * no new error code here, because an unusable list is not something the UI can
 * ask the user to act on.
 */
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
  // Truthiness for `error`, deliberately not `!== undefined`: a BYO backend can
  // send `error: null`, which both callers' own `if (response.error)` reads as
  // success before consuming `data` — waving that envelope through would leave
  // exactly the payload this module exists to check unvalidated. `data` is
  // nullish-checked for the mirror-image reason: nothing downstream reads it.
  if (res.error || res.data === undefined || res.data === null) {
    return res as ApiResponse<FamilyGroup>;
  }

  // A non-object `data` carries no `FamilyGroup` field at all, so there is
  // nothing to pass through — it degrades to a members-only group, and its
  // missing `members` is reported by the array check like any other
  // malformation.
  const claimed: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const claimedEndpoint = claimed.apiEndpoint;

  return {
    ...res,
    data: {
      ...(claimed as unknown as FamilyGroup),
      members: sanitizeFamilyMembers(claimed.members),
      // The one pass-through field rendered as a React child — the
      // transfer-owner confirm screen prints it (`dialog/MemberList.tsx`,
      // `.moo-member-list__endpoint`) — so an object-valued claim throws there,
      // exactly the crash class the other fields' `===` / `??` consumers are
      // immune to. Any string survives verbatim; everything else collapses to
      // `null`, which is what `apiEndpoint ?? undefined` already reads as "no
      // custom endpoint".
      apiEndpoint: typeof claimedEndpoint === "string" ? claimedEndpoint : null,
    },
  };
}
