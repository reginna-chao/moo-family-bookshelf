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
 *
 * When that re-join is refused with a family-gone code instead, the local family
 * data is cleared and the dialog falls back to onboarding — see
 * `tearDownGoneFamily`. That branch is not hypothetical: the server's
 * verification gate runs BEFORE its kicked-tombstone check, so a removed member
 * whose account has verification configured cannot learn of the removal until
 * they have supplied a valid secret.
 */

import { useEffect } from "react";
import browser from "webextension-polyfill";
import { clearFamilyStorageAndBroadcast } from "../api/auth-refresh";
import type { ApiClient } from "../api/client";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  DISPLAY_NAME_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
} from "../constants";
import { safeStorageGet } from "../storage/safeStorage";
import {
  isVerificationError,
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
    return {
      ok: false,
      errorCode: res.error.code,
      retryAfter: res.error.retryAfter,
      errorMessage: res.error.message,
    };
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

/**
 * Tear down the local family binding after a re-verification join came back with
 * a family-gone code (family deleted / full / owner removed this member).
 *
 * The secret was CORRECT here — the silent recovery never got past the server's
 * verification gate, so the refusal only surfaces once the user has typed a
 * valid PIN/pattern. Without this teardown the prompt would keep re-offering the
 * same input and the user would loop on "correct secret → error" for as long as
 * the server's kicked tombstone lives (6h).
 */
async function tearDownGoneFamily(apiClient: ApiClient): Promise<void> {
  try {
    await clearFamilyStorageAndBroadcast();
  } catch (err) {
    // `storage.local.remove` inside is unguarded, so this can reject. Swallow
    // it: a storage failure must not strand the latch — a stale one mutes every
    // later 401 for the rest of the session and the view never flips.
    console.warn("[Reauth] Family teardown storage clear failed", err);
  } finally {
    // The 401 path that raised this prompt already nulled the token; repeated
    // here because this hook owns the client's state rather than inheriting it
    // from whoever ran before (and `onFamilyRemoved` below is optional).
    apiClient.setAuthToken(null);
    // Release the latch BEFORE handing over: while it is set every later 401
    // skips silent recovery, so a stale one would mute re-auth for good.
    apiClient.clearReauthPending();
    // Last, so the dialog only flips to onboarding once storage and the client
    // are already consistent with "this user has no family".
    apiClient.onFamilyRemoved?.();
  }
}

export function useReauth(
  apiClient: ApiClient,
  opts?: UseReauthOptions,
): UseVerificationPromptResult {
  const verify = useVerificationPrompt(apiClient);
  const verifyBegin = verify.begin;
  const onSuccess = opts?.onSuccess;

  useEffect(() => {
    apiClient.onReauthRequired = (info) => {
      void (async () => {
        const stored = await safeStorageGet([
          USER_ID_KEY,
          FAMILY_ID_KEY,
          DISPLAY_NAME_KEY,
        ]);
        const userId = stored[USER_ID_KEY] as string | undefined;
        const familyId = stored[FAMILY_ID_KEY] as string | undefined;
        const displayName =
          (stored[DISPLAY_NAME_KEY] as string | undefined) ?? "";
        if (!userId || !familyId) {
          // Storage lacks the identity needed to re-join, so no prompt can be
          // shown. Release the latch the client set before invoking us —
          // otherwise it stays true forever and later 401 waves skip recovery
          // silently (no re-auth prompt ever appears again).
          apiClient.clearReauthPending();
          return;
        }

        // Seed with the code that actually blocked the silent recovery, so a
        // locked user sees the countdown right away instead of an active input.
        // Anything unexpected falls back to VERIFICATION_REQUIRED, which fetches
        // the method and renders the matching challenge (pin / pattern / OTP).
        const blocked = isVerificationError(info?.errorCode) ? info : undefined;
        await verifyBegin(
          blocked?.errorCode ?? "VERIFICATION_REQUIRED",
          {
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
            // The gate answers before the server's kicked-tombstone check, so a
            // removed member reaches this verdict only after passing it.
            onFamilyGone: () => tearDownGoneFamily(apiClient),
          },
          blocked?.retryAfter,
        );
      })();
    };
    return () => {
      apiClient.onReauthRequired = null;
    };
  }, [apiClient, verifyBegin, onSuccess]);

  return verify;
}
