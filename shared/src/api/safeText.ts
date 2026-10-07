/** Text-layer coercion primitives for backend TEXT fields (per-entity sanitizers: `./entityText.ts`).
 *  Threat model, `""` degradation, excluded fields: docs/architecture.md → 伺服器回傳資料的檢查. */

/** A backend text field, guaranteed to be a string. */
export function safeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A text field whose `null` carries meaning — `apiEndpoint: null` is "this
 * family uses the default endpoint", not "missing". `null` survives, and any
 * other non-string degrades to `null` rather than `""`, so a caller's tri-state
 * chain (`apiEndpoint ?? undefined`) keeps exactly the three values it had.
 *
 * `undefined` also degrades to `null`: callers guard `=== undefined` themselves
 * when the field is optional, so absence stays absence.
 */
export function safeNullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Can this value carry the fields a sanitizer rewrites? Arrays excluded on purpose — the same
 *  predicate as `isRecord` in `shared/src/borrow/validation.ts`, one definition for both layers. */
function isRecordLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply a sanitizer to a payload that claims to be an entity.
 *
 * Three outcomes, and the split between the last two is the whole point:
 *  - A plain object is sanitized field by field.
 *  - `null` / `undefined` pass through UNCHANGED. A missing payload must stay
 *    missing: every caller already guards it (`if (!response.data)`, and
 *    `sanitizeEnvelope` in both API clients returns early on `undefined` data),
 *    so fabricating an entity here would turn "the backend sent nothing" into
 *    "the backend sent an empty family" — a different and worse lie.
 *  - Anything ELSE — a primitive, or an array — is garbage that nonetheless
 *    walks past those guards, since `[]` and `"x"` are both truthy. It degrades
 *    to `sanitize({})`, letting the per-entity sanitizer materialize its own
 *    safe shape: `""` for every text field, `[]` for every list, optionals left
 *    absent. A NESTED required record stays `undefined` — it recurses into this
 *    same helper and hits the pass-through branch. The one case today is
 *    `sanitizePublicShelfResultText`'s `shelf`, and that is the right outcome:
 *    a blank shelf would render a share URL built on an empty token, which is a
 *    worse lie than "no shelf". Callers guard it (`shelf ? … : ""`).
 *    That renders as an EMPTY state instead of throwing on the first field
 *    read — the same degradation philosophy as `""` for text, one level up.
 *
 * The empty-entity branch is what closes the container half of the white-screen
 * gap: `data: []` and `data: "x"` otherwise reach the exact render line a
 * malformed list does — `setMembers(undefined)`, then `members.length`.
 *
 * An array is garbage here and is never SPREAD: `{ ...arr, familyId: "" }` would
 * carry the array's numeric keys and dress a malformed payload up as a valid
 * entity. Excluding arrays is also what keeps the predicate identical to
 * `isRecord` in `shared/src/borrow/validation.ts`.
 */
export function sanitizeRecord<T>(value: T, sanitize: (record: T) => T): T {
  if (isRecordLike(value)) return sanitize(value);
  if (value === null || value === undefined) return value;
  return sanitize({} as T);
}

/**
 * Sanitize every element of a backend-supplied list.
 *
 * FAIL-CLOSED with no pass-through escape hatch at all — where `sanitizeRecord`
 * still lets `null` / `undefined` reach the caller's own guard, a MISSING list
 * materializes as `[]` here, because a list is consumed differently.
 * `GET /api/family/:id/members` answering
 * `members: [null]` is stored straight into React state (`setMembers` in
 * `extension/src/dialog/useFamilyDataMembers.ts`, outside any `try`) and only
 * detonates on the NEXT render, at `members.map` + `member.displayName` in
 * `extension/src/dialog/MemberList.tsx`; `members: "oops"` does the same at
 * `members.length`. A throw from render is unreachable to every caller
 * `try/catch`, and with no ErrorBoundary in either app it is a permanent white
 * screen — precisely the outcome this module exists to prevent.
 *
 * So: a non-array container degrades to `[]`, an element that cannot carry
 * fields (`null`, a primitive, a nested array) is DROPPED, and the survivors are
 * sanitized. A MISSING list therefore materializes as `[]` too — the list-level
 * counterpart of a required text field materializing as `""`. Losing a hostile
 * element is affordable here in a way it is not for a record: "no members" /
 * "no books" is a state the UI already renders.
 *
 * Dropping is deliberately SILENT — no `console.warn`, unlike
 * `shared/src/borrow/validation.ts` / `shared/src/api/memberValidation.ts`,
 * whose aggregate warnings sit on single fetch paths. This helper runs inside
 * the bookshelf aggregation and other hot paths, where a per-response warning
 * would be noise; the omission is a policy choice, not an oversight.
 *
 * The stricter precedent is `shared/src/borrow/validation.ts`, which already
 * answers a malformed borrow container with `[]` and drops unaddressable
 * elements; keeping the two policies aligned is what stops them from drifting
 * apart.
 */
export function sanitizeList<T>(list: T[], sanitize: (item: T) => T): T[] {
  if (!Array.isArray(list)) return [];
  // `Array.isArray` narrows to `any[]`; re-type so element access stays checked.
  const items: unknown[] = list;
  return items
    .filter((item): item is T => isRecordLike(item))
    .map((item) => sanitize(item));
}
