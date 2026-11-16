/** Shape of the `POST /api/auth/refresh` reply for `ApiClient.refreshAuthToken`, split out of
 *  `client.ts` to keep it under its line ceiling. Rationale: docs/architecture.md → PWA 主動續期. */

import {
  isAuthToken,
  isExpiresAt,
} from "moo-family-bookshelf-shared/api/issuedCredentials";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";

/** An `error` passes through alone; a bad token is `INVALID_RESPONSE`; a bad expiry is dropped. */
export function shapeRefreshResponse(
  res: ApiResponse<{ token?: unknown; expiresAt?: unknown }>,
): ApiResponse<{ token: string; expiresAt?: number }> {
  if (res.error) return { error: res.error };
  const token = res.data?.token;
  if (!isAuthToken(token)) {
    return {
      error: {
        code: "INVALID_RESPONSE",
        message: "refresh response carried no usable token",
      },
    };
  }
  const expiresAt = res.data?.expiresAt;
  return { data: { token, ...(isExpiresAt(expiresAt) && { expiresAt }) } };
}
