/**
 * Per-route request-body size limits for the `/api/*` body guard in `index.ts`.
 *
 * Every route keeps the 256KB default except the full personal-shelf upload,
 * `PUT /api/user/:id/books`, which carries the WHOLE book list (~400–500 bytes
 * of JSON per realistic book) and so needs room for large libraries: 2MB is
 * roughly 4000–5000 realistic books. PATCH on the same path (a change set) and
 * `/family-prefs` stay on the default.
 */

/** Default max request body size: 256KB. */
export const DEFAULT_MAX_BODY_SIZE = 256 * 1024;

/** Max request body size for `PUT /api/user/:id/books`: 2MB. */
export const PUT_BOOKS_MAX_BODY_SIZE = 2 * 1024 * 1024;

export interface BodyLimit {
  /** Largest accepted body, in bytes. */
  maxBytes: number;
  /** Human label used in the 413 message, e.g. `256KB`. */
  label: string;
}

const DEFAULT_LIMIT: BodyLimit = {
  maxBytes: DEFAULT_MAX_BODY_SIZE,
  label: "256KB",
};

const PUT_BOOKS_LIMIT: BodyLimit = {
  maxBytes: PUT_BOOKS_MAX_BODY_SIZE,
  label: "2MB",
};

/** Exactly `/api/user/{id}/books` — one path segment for `{id}`, no suffix. */
const PUT_BOOKS_PATH = /^\/api\/user\/[^/]+\/books$/;

/** Classify a request into its body-size limit. Pure. */
export function bodyLimitFor(method: string, path: string): BodyLimit {
  if (method === "PUT" && PUT_BOOKS_PATH.test(path)) return PUT_BOOKS_LIMIT;
  return DEFAULT_LIMIT;
}

/** Max accepted body size in bytes for a request. Pure. */
export function maxBodySizeFor(method: string, path: string): number {
  return bodyLimitFor(method, path).maxBytes;
}

/** The 413 `PAYLOAD_TOO_LARGE` message for a limit — API contract, never reword. */
export function payloadTooLargeMessage(limit: BodyLimit): string {
  return `Request body exceeds ${limit.label} limit`;
}
