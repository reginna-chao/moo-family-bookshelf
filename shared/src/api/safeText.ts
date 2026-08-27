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
 * Not covered here, deliberately:
 *  - `error.message` / `error.code` — owned by the error-text hardening.
 *  - Cover URLs (`coverUrl`, `bookCoverUrl`) — they only reach an attribute,
 *    which the DOM string-coerces, so they cannot crash React; their own
 *    sanitization (URL-scheme allowlisting) is a separate concern.
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
 * Apply a sanitizer only to a value that can actually carry fields.
 *
 * A `data` payload that is not a non-null object passes through untouched:
 * reading through `null` would throw a TypeError out of the API client, turning
 * this hardening layer into the very failure it exists to prevent. Such a
 * payload then reaches the caller exactly as it did before this layer existed.
 */
export function sanitizeRecord<T>(value: T, sanitize: (record: T) => T): T {
  return typeof value === "object" && value !== null ? sanitize(value) : value;
}

/**
 * Sanitize every element of a backend-supplied list.
 *
 * Same fail-safe contract as `sanitizeRecord`, one level up: a `list` that is
 * not an array is returned as-is instead of being handed to `.map`, and each
 * element goes through `sanitizeRecord` so a `null` entry cannot throw here.
 * Callers that already guard with `Array.isArray` keep behaving identically.
 */
export function sanitizeList<T>(list: T[], sanitize: (item: T) => T): T[] {
  if (!Array.isArray(list)) return list;
  return list.map((item) => sanitizeRecord(item, sanitize));
}
