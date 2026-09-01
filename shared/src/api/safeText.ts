/**
 * Runtime coercion primitives for backend-supplied TEXT fields, applied at the
 * API-client boundary of BOTH apps. The per-entity sanitizers built on top of
 * these live in `./entityText.ts`.
 *
 * Why this exists: both clients read their envelope through a bare cast
 * (`(await response.json()) as ApiResponse<T>`), and the endpoint is
 * user-configurable — a sync code's `@host` segment repoints the whole app at a
 * self-hosted (BYO) backend. So every field the app types call `string` is
 * really `unknown` at runtime, and a hostile or merely buggy backend has two
 * ways to kill the UI outright. Neither app can recover from either: there is
 * no ErrorBoundary in the Extension dialog or in the PWA, so both are a
 * PERMANENT white screen until the user reloads.
 *
 *  1. An object reaching a JSX child — React 19 throws "Objects are not valid
 *     as a React child" and unmounts the tree.
 *  2. A string method called on a non-string — `title.toLowerCase()` in
 *     `useSearch`, `createdAt.localeCompare()` in the borrow buckets,
 *     `title.trim()` in the public-share dialog and in `publicShelf/diff.ts`.
 *     TypeError thrown from render / useMemo, same outcome.
 *
 * The degraded value is `""`, deliberately, and there is NO fallback parameter:
 * fallback copy belongs at the call sites that already carry it (`displayName ||
 * userId.slice(0, 8)`, `{book.author && …}`), and `""` is falsy, so those
 * existing `||` chains and truthy gates keep supplying it. A real string —
 * including `""` itself, which IS the degraded form — passes through
 * byte-identical: this layer coerces TYPES, it never trims, normalizes or
 * rewrites content.
 *
 * The two CONTAINER helpers both degrade rather than pass garbage on, and the
 * one asymmetry between them is deliberate:
 *  - `sanitizeRecord` passes `null` / `undefined` straight through — a missing
 *    payload must STAY missing, and every caller already guards for it — while
 *    any other non-object (a primitive, an array) degrades to an EMPTY entity,
 *    because those slip past the very same guards (`[]` and `"x"` are truthy)
 *    and then crash the first field read.
 *  - `sanitizeList` degrades a malformed container to `[]` and drops an element
 *    that cannot carry fields.
 * Both land on the principle already used for text: renderable emptiness beats a
 * throw. A bad container or element detonates one render later — inside `.map`
 * or a field read — where no caller `try` can reach it, and with no
 * ErrorBoundary in either app that is a permanent white screen.
 * `extension/src/api/borrowValidation.ts` and its PWA twin already apply this
 * strictness to the borrow list; this layer now matches it.
 *
 * Not covered here, deliberately:
 *  - `error.message` / `error.code` — owned by the error-text hardening.
 *  - Cover URLs (`coverUrl`, `bookCoverUrl`) — excluded because neither of the
 *    two places they reach can be crashed by a non-string, which is a two-part
 *    claim and both parts are load-bearing. They render into an `<img src>`
 *    attribute, which the DOM string-coerces; and they run through the Readmoo
 *    URL whitelist first (`safeCoverUrl` in `extension/src/dialog/` and
 *    `pwa/src/utils/` → `isAllowedCoverUrl` in
 *    `shared/src/config/readmoo.ts`), which guards its OWN input type — its
 *    fast path is `typeof`-guarded so a non-string degrades to `false` instead
 *    of throwing `TypeError` from render. That whitelist is a separate concern
 *    (domain allowlisting, not type coercion) and stays where it is; if it ever
 *    drops that guard, this exclusion stops being safe and these fields must be
 *    coerced here instead. The `describe` block "isAllowedCoverUrl /
 *    isAllowedBookUrl on non-string input" in
 *    `extension/tests/unit/readmooConfig.test.ts` is what turns red if that
 *    guard goes; this note only records why the loss would reach here.
 *  - Numbers, `BoolFlag` flags and string-literal unions (`status`,
 *    `selectionMode`, `method`) — a plain `string` would break their types, and
 *    their render sites harden them with `ReadonlyMap` lookups instead.
 */

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

/**
 * Can this value carry the fields a sanitizer is about to rewrite?
 *
 * Arrays are excluded on purpose, so this is the same predicate as `isRecord` in
 * `extension/src/api/borrowValidation.ts` (and its PWA twin) — one definition of
 * "addressable record" across both hardening layers.
 */
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
 * `isRecord` in `extension/src/api/borrowValidation.ts` (and its PWA twin).
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
 * `extension/src/dialog/FamilyDataContext.tsx`, outside any `try`) and only
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
 * `borrowValidation.ts` / `memberValidation.ts`, whose aggregate warnings sit on
 * single fetch paths. This helper runs inside the bookshelf aggregation and
 * other hot paths, where a per-response warning would be noise; the omission is
 * a policy choice, not an oversight.
 *
 * The stricter precedent is `extension/src/api/borrowValidation.ts` (and its PWA
 * twin), which already answers a malformed borrow container with `[]` and drops
 * unaddressable elements; keeping the two policies aligned is what stops them
 * from drifting apart.
 */
export function sanitizeList<T>(list: T[], sanitize: (item: T) => T): T[] {
  if (!Array.isArray(list)) return [];
  // `Array.isArray` narrows to `any[]`; re-type so element access stays checked.
  const items: unknown[] = list;
  return items
    .filter((item): item is T => isRecordLike(item))
    .map((item) => sanitize(item));
}
