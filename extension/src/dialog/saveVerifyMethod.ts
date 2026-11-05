import browser from "webextension-polyfill";
import type {
  SetVerifyBody,
  SetVerifyResult,
} from "moo-family-bookshelf-shared/api/verifyTypes";
import type { ApiClient } from "../api/client";
import { storageMatches } from "../api/tokenBinding";
import type { ApiResponse, VerifyMethod } from "../api/types";
import { AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from "../constants";

/**
 * Save the verify method, then store the auth token a new pin / pattern
 * rotated (#378) so other Readmoo tabs, the background and the content scripts
 * read the new one — the old token is revoked server-side. `apiClient` already
 * holds the new token; storage takes it only while it still names this client's
 * server (#456), and a storage failure is only logged, never turned into a
 * failed save. `currentSecret` is the account's current PIN / pattern, which
 * the server requires while the current method is either (#396).
 */
export async function saveVerifyMethod(
  apiClient: ApiClient,
  userId: string,
  method: VerifyMethod,
  secret?: string,
  currentSecret?: string,
): Promise<ApiResponse<SetVerifyResult>> {
  const body: SetVerifyBody = { method };
  if (secret) body.secret = secret;
  if (currentSecret !== undefined) body.currentSecret = currentSecret;
  const result = await apiClient.setVerifyMethod(userId, body);
  if (!result.error && result.data?.authToken !== undefined) {
    await storeRotatedToken(result.data, apiClient.getEndpoint());
  }
  return result;
}

async function storeRotatedToken(
  data: SetVerifyResult,
  endpoint: string,
): Promise<void> {
  const update: Record<string, unknown> = { [AUTH_TOKEN_KEY]: data.authToken };
  if (data.expiresAt !== undefined) {
    update[TOKEN_EXPIRES_AT_KEY] = data.expiresAt;
  }
  try {
    // Another tab moved storage to another server: the token stays in this client's memory only.
    if (!(await storageMatches(endpoint))) return;
    await browser.storage.local.set(update);
  } catch (err) {
    console.warn(
      "[VerificationSettings] Failed to store the rotated token",
      err,
    );
  }
}
