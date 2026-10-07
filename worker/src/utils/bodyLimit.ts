/** Per-route body limits for the `/api/*` guard in `index.ts`: 256KB default; 2MB only for the WHOLE-list
 *  `PUT /api/user/:id/books` (~400–500 B JSON per book ⇒ ~4000–5000 books). PATCH / family-prefs: default. */

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
