/** The `PUT /api/user/:id/verify` response: a new pin / pattern revokes the account's shared
 *  auth token and issues its replacement (#378). Why: docs/architecture.md → 伺服器回傳資料的檢查. */

import type { ApiResponse } from "./types";
import type { SetVerifyResult } from "./verifyTypes";
import { sanitizeIssuedCredentials } from "./issuedCredentials";

/** Reject primitives, `null`, and arrays; only a plain object can carry `authToken`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check a `PUT /api/user/:id/verify` envelope and hand its issued token to
 * `adopt` BEFORE returning, so the caller's very next request already carries
 * it — the old token is dead from the moment the server answered. A token or
 * expiry in the wrong shape is dropped (`sanitizeIssuedCredentials`) and reads
 * exactly as if none was issued: `adopt` is not called. An error envelope, or
 * a missing / non-object `data`, is returned untouched and adopts nothing.
 */
export function adoptRotatedVerifyToken(
  res: ApiResponse<unknown>,
  adopt: (authToken: string) => void,
): ApiResponse<SetVerifyResult> {
  if (res.error || !isRecord(res.data)) {
    return res as ApiResponse<SetVerifyResult>;
  }
  // `method` / `prompted` are not checked: no caller reads them.
  const data = sanitizeIssuedCredentials(res.data) as unknown;
  const result = data as SetVerifyResult;
  if (result.authToken !== undefined) adopt(result.authToken);
  return { ...res, data: result };
}
