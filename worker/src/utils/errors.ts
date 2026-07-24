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

/**
 * Build a typed JSON error response with the standard
 * `{ error: { code, message } }` envelope. Generic over the status literal so
 * OpenAPIHono handlers keep their concrete status-code typing. Returns the same
 * `Response & TypedResponse<...>` intersection that `c.json` produces, so callers
 * can `return` it (or return it from a guard helper) without any cast.
 */
export function jsonError<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: string,
  message: string,
): Response & TypedResponse<ErrorBody, S, "json"> {
  return c.json({ error: { code, message } }, status);
}
