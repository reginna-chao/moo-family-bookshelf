/** Envelope unwrapping and sanitizing for `client.ts`, split out of it to keep it under its line
 *  ceiling. Rationale: docs/architecture.md → API client 的回應處理. */

import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { sanitizeRecord } from "moo-family-bookshelf-shared/api/safeText";
import { ApiError } from "moo-family-bookshelf-shared/api/types";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";

/** Unwrap an envelope response or throw an `ApiError` built from `error`. */
export function unwrap<T>(res: ApiResponse<T>): T {
  throwOnError(res);
  if (res.data === undefined) {
    throw new ApiError("EMPTY_RESPONSE", "response body missing data");
  }
  return res.data;
}

/** `unwrap` for bodyless (204) successes: only `error` throws — demanding `data` would turn every
 *  successful 204 into a bogus EMPTY_RESPONSE. */
export function unwrapVoid(res: ApiResponse<unknown>): void {
  throwOnError(res);
}

/** Coerce a success payload's backend TEXT fields so no consumer holds a non-string `string` field
 *  (`shared/src/api/safeText.ts`); error envelopes and bodyless successes pass untouched. */
export function sanitizeEnvelope<T>(
  res: ApiResponse<T>,
  sanitize: (data: T) => T,
): ApiResponse<T> {
  if (res.data === undefined) return res;
  return { ...res, data: sanitizeRecord(res.data, sanitize) };
}

/** Single chokepoint for every thrown `ApiError`: sanitizes `code` / `message` so a hostile value
 *  cannot make the constructor itself throw (docs/architecture.md → API client 的回應處理). */
function throwOnError(res: ApiResponse<unknown>): void {
  if (res.error) {
    throw new ApiError(
      safeErrorText(res.error.code, "UNKNOWN_ERROR"),
      safeErrorText(res.error.message, "請稍後再試"),
      res.error.retryAfter,
    );
  }
}
