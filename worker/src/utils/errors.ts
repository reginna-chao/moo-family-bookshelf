import type { Context, TypedResponse } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Canonical machine-readable API error envelope body. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Optional back-off hint (seconds) for retryable errors such as 429 RATE_LIMITED; mirrors
     *  `Retry-After` so envelope-only clients can still schedule an auto-retry. */
    retryAfter?: number;
  };
}

/** Optional extras for {@link jsonError}. */
export interface JsonErrorOptions {
  /** Back-off hint in whole seconds, emitted as both `error.retryAfter` and the `Retry-After` header. */
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

/** Status + envelope copy for a thrown error that is the CLIENT's fault. */
export interface ClientErrorCopy {
  status: ContentfulStatusCode;
  code: string;
  message: string;
}

/** `hono/validator`'s message for an unparsable declared `json` body (hono 4.x), matched verbatim: a
 *  rewording upgrade degrades that case to the generic REQUEST_REJECTED 400 — still a 400. */
const HONO_MALFORMED_JSON_MESSAGE = "Malformed JSON in request body";

/**
 * Classify an error that reached the root `app.onError`: the 4xx copy to
 * answer with, or `null` when it is a genuine server fault (answer 500 + log).
 *
 * Only Hono's `HTTPException` can be a client error here. Nothing reachable
 * today throws one — no code under `worker/src` throws it, no route declares a
 * `request.body` schema, and the `param` validation every route does declare
 * answers through `defaultHook` instead of throwing — so this is a
 * prerequisite for the first route that declares a body (`utils/openapi.ts`):
 * - 400 from the JSON validator ⇒ `INVALID_JSON`, byte-identical to the
 *   handlers' own unparsable-body answer.
 * - 415 from zod-openapi's media-type gate (a declared body sent with another
 *   or no Content-Type) ⇒ `UNSUPPORTED_MEDIA_TYPE`.
 * - Any other 4xx ⇒ that status with the generic `REQUEST_REJECTED`.
 *
 * `err.message` is never echoed: Hono's FormData parse failure appends the
 * underlying parser's error text to it, which this Worker does not control.
 * An `HTTPException`'s own `res` / headers are dropped too — the envelope is
 * always ours. A 5xx `HTTPException` stays a server fault.
 */
export function clientErrorFor(err: Error): ClientErrorCopy | null {
  if (!(err instanceof HTTPException)) return null;
  const { status } = err;
  if (status === 400 && err.message === HONO_MALFORMED_JSON_MESSAGE) {
    return {
      status,
      code: "INVALID_JSON",
      message: "Request body must be valid JSON",
    };
  }
  if (status === 415) {
    return {
      status,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Request Content-Type is not supported",
    };
  }
  if (status >= 400 && status < 500) {
    return {
      status,
      code: "REQUEST_REJECTED",
      message: "Request was rejected",
    };
  }
  return null;
}
