import type { Context, TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Canonical machine-readable API error envelope body. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /**
     * Optional back-off hint (seconds) for retryable errors such as 429
     * RATE_LIMITED. Mirrors the `Retry-After` header so clients that only parse
     * the JSON envelope can still schedule an auto-retry.
     */
    retryAfter?: number;
  };
}

/** Optional extras for {@link jsonError}. */
export interface JsonErrorOptions {
  /**
   * Back-off hint in whole seconds. When provided it is emitted both as
   * `error.retryAfter` in the body and as the `Retry-After` response header.
   */
  retryAfter?: number;
}

/**
 * Build a typed JSON error response with the standard
 * `{ error: { code, message } }` envelope. Generic over the status literal so
 * OpenAPIHono handlers keep their concrete status-code typing. Returns the same
 * `Response & TypedResponse<...>` intersection that `c.json` produces, so callers
 * can `return` it (or return it from a guard helper) without any cast.
 *
 * Passing `options.retryAfter` additively augments the envelope with a back-off
 * hint; omitting it keeps the exact legacy body shape.
 */
export function jsonError<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: string,
  message: string,
  options?: JsonErrorOptions,
): Response & TypedResponse<ErrorBody, S, "json"> {
  const retryAfter = options?.retryAfter;
  if (retryAfter === undefined) {
    return c.json({ error: { code, message } }, status);
  }
  return c.json({ error: { code, message, retryAfter } }, status, {
    "Retry-After": String(retryAfter),
  });
}
