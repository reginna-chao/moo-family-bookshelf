/**
 * useReauth — drives the in-place re-verification prompt shown when the auth
 * token dies server-side and silent recovery is blocked by a PWA-login
 * verification requirement (security-ux Invariant 2: token expiry must prompt
 * re-authentication, never silently drop data).
 *
 * It reuses the existing verification prompt machinery (useVerificationPrompt +
 * VerificationPrompt) and wires `apiClient.onReauthRequired`. On completion it
 * re-joins the family with the collected secret, persists the fresh token, and
 * dismisses the prompt so the user continues exactly where they were.
 */

import { useEffect } from "react";
import browser from "webextension-polyfill";
import type { ApiClient } from "../api/client";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  DISPLAY_NAME_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
} from "../constants";
import {
  useVerificationPrompt,
  type UseVerificationPromptResult,
  type VerificationAttemptResult,
} from "./useVerificationPrompt";

export interface UseReauthOptions {
  /**
   * Invoked once the re-join succeeds (fresh token persisted + primed in the
   * client). App uses it to reload the dialog's family data so the stale 401
   * view is replaced automatically instead of waiting for a manual retry.
   */
  onSuccess?: () => void;
}

/**
 * Re-join the family with the supplied verification secret. On success persist
 * the fresh token and prime the in-memory client; on failure surface the code
 * so the prompt can retry / show locked messaging.
 */
async function runReauthJoin(
  apiClient: ApiClient,
  familyId: string,
  userId: string,
  displayName: string,
  verifySecret: string,
  onSuccess?: () => void,
): Promise<VerificationAttemptResult> {
  const res = await apiClient.joinFamily(familyId, userId, displayName, {
    verifySecret,
  });
  if (res.error) {
    return { ok: false, errorCode: res.error.code };
  }
  const authToken = res.data?.authToken;
  if (authToken) {
    apiClient.setAuthToken(authToken);
    const update: Record<string, unknown> = { [AUTH_TOKEN_KEY]: authToken };
    if (res.data?.expiresAt) {
      update[TOKEN_EXPIRES_AT_KEY] = res.data.expiresAt;
    }
    await browser.storage.local.set(update);
  }
  // A successful manual re-verification proves the credentials are valid again,
  // so a leftover recovery cooldown must not survive to throttle the next
  // silent refresh.
  await browser.storage.local.remove(RECOVERY_COOLDOWN_UNTIL_KEY);
  onSuccess?.();
  return { ok: true };
}

export function useReauth(
  apiClient: ApiClient,
  opts?: UseReauthOptions,
): UseVerificationPromptResult {
  const verify = useVerificationPrompt(apiClient);
  const verifyBegin = verify.begin;
  const onSuccess = opts?.onSuccess;

  useEffect(() => {
    apiClient.onReauthRequired = () => {
      void (async () => {
        const stored = await browser.storage.local.get([
          USER_ID_KEY,
          FAMILY_ID_KEY,
          DISPLAY_NAME_KEY,
        ]);
        const userId = stored[USER_ID_KEY] as string | undefined;
        const familyId = stored[FAMILY_ID_KEY] as string | undefined;
        const displayName = (stored[DISPLAY_NAME_KEY] as string | undefined) ?? "";
        if (!userId || !familyId) {
          // Storage lacks the identity needed to re-join, so no prompt can be
          // shown. Release the latch the client set before invoking us —
          // otherwise it stays true forever and later 401 waves skip recovery
          // silently (no re-auth prompt ever appears again).
          apiClient.clearReauthPending();
          return;
        }

        // Seed with VERIFICATION_REQUIRED so the prompt fetches the method and
        // renders the matching challenge (pin / pattern / OTP guidance).
        await verifyBegin("VERIFICATION_REQUIRED", {
          userId,
          retry: (verifySecret) =>
            runReauthJoin(
              apiClient,
              familyId,
              userId,
              displayName,
              verifySecret,
              onSuccess,
            ),
          // Abandoning the prompt just closes it; the user stays on the main
          // view. Release the reauth latch so a later authenticated action can
          // re-trigger the challenge (otherwise the latch would suppress it).
          onCancel: () => {
            apiClient.clearReauthPending();
          },
        });
      })();
    };
    return () => {
      apiClient.onReauthRequired = null;
    };
  }, [apiClient, verifyBegin, onSuccess]);

  return verify;
}
