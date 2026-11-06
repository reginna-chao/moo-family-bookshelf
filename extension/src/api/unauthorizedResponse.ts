/** The envelopes a 401 ends in when no retry happens, split out of `transport.ts` to keep it under
 *  its line cap. See docs/architecture.md → 認證更新與冷卻. */

import { buildRateLimitMessage } from "./rateLimitMessage";
import { synthesizeError } from "./synthesizedError";
import { AUTH_REFRESH_RATE_LIMITED, type ApiResponse } from "./types";

/** The server's own 401 error, or a generic one when its envelope carried none. */
export function unauthorizedFailure<T>(json: ApiResponse<T>): ApiResponse<T> {
  return {
    error: json.error ?? {
      code: "UNAUTHORIZED",
      message: "Authentication failed",
    },
  };
}

/** Rate-limited recovery: a client-synthesized localized error, not the raw English 401 — its
 *  own code + marker let the UI show it verbatim. docs/architecture.md → 認證更新與冷卻. */
export function rateLimitedFailure<T>(
  cooldownUntil: number | undefined,
): ApiResponse<T> {
  return {
    error: synthesizeError(
      AUTH_REFRESH_RATE_LIMITED,
      buildRateLimitMessage(cooldownUntil),
    ),
  };
}
