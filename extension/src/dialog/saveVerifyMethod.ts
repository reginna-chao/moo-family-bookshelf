import browser from "webextension-polyfill";
import type { SetVerifyResult } from "moo-family-bookshelf-shared/api/verifyTypes";
import type { ApiClient } from "../api/client";
import type { ApiResponse, VerifyMethod } from "../api/types";
import { AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from "../constants";

/**
 * Save the verify method, then store the auth token a new pin / pattern
 * rotated (#378) so other Readmoo tabs, the background and the content scripts
 * read the new one — the old token is revoked server-side. `apiClient` already
 * holds the new token; a storage failure is only logged, never turned into a
 * failed save.
 */
export async function saveVerifyMethod(
  apiClient: ApiClient,
  userId: string,
  method: VerifyMethod,
  secret?: string,
): Promise<ApiResponse<SetVerifyResult>> {
  const body: { method: VerifyMethod; secret?: string } = { method };
  if (secret) body.secret = secret;
  const result = await apiClient.setVerifyMethod(userId, body);
  if (!result.error && result.data?.authToken !== undefined) {
    await storeRotatedToken(result.data);
  }
  return result;
}

async function storeRotatedToken(data: SetVerifyResult): Promise<void> {
  const update: Record<string, unknown> = { [AUTH_TOKEN_KEY]: data.authToken };
  if (data.expiresAt !== undefined) {
    update[TOKEN_EXPIRES_AT_KEY] = data.expiresAt;
  }
  try {
    await browser.storage.local.set(update);
  } catch (err) {
    console.warn(
      "[VerificationSettings] Failed to store the rotated token",
      err,
    );
  }
}
