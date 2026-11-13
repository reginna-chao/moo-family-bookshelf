// Drives the in-place re-verification prompt when PWA-login verification blocks silent recovery
// (Invariant 2). See docs/architecture.md → 重新驗證視窗.

import { useEffect } from "react";
import browser from "webextension-polyfill";
import { clearFamilyStorage } from "../api/auth-refresh";
import { storageMatches, storeIssuedToken } from "../api/tokenBinding";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { BoolFlag, type ApiClient } from "../api/client";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  DISPLAY_NAME_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
} from "../constants";
import { resetFamilyEndpointChoice } from "../storage/familyEndpointChoice";
import { safeStorageGet } from "../storage/safeStorage";
import { STALE_SESSION_CODE, STALE_SESSION_MESSAGE } from "./verificationCodes";
import {
  isVerificationError,
  useVerificationPrompt,
  type UseVerificationPromptResult,
  type VerificationAttemptResult,
} from "./useVerificationPrompt";

export interface UseReauthOptions {
  /** Invoked once the re-join succeeds (fresh token persisted and primed); App reloads the family
   *  data so the stale 401 view is replaced without a manual retry. */
  onSuccess?: () => void;
}

const STALE_SESSION_RESULT: VerificationAttemptResult = {
  ok: false,
  errorCode: STALE_SESSION_CODE,
  errorMessage: STALE_SESSION_MESSAGE,
};

/** Re-join with the secret, flagged `recovery` (409 RECOVERY_NOT_MEMBER for a user no longer listed).
 *  Success persists and primes the token; failure returns the code for the prompt. `server` is where
 *  the prompt opened: no secret leaves once the client has moved off it. */
async function runReauthJoin(
  apiClient: ApiClient,
  server: string,
  familyId: string,
  userId: string,
  displayName: string,
  verifySecret: string,
  onSuccess?: () => void,
): Promise<VerificationAttemptResult> {
  if (apiClient.getEndpoint() !== server) return STALE_SESSION_RESULT;
  const res = await apiClient.joinFamily(familyId, userId, displayName, {
    verifySecret,
    recovery: BoolFlag.TRUE,
  });
  // Before the response is read: a late token must not bind to the client's new server, and another
  // tab's binding is neither overwritten nor torn down; the read comes first so a switch during it
  // is caught too. docs/architecture.md → 重新驗證視窗.
  if (
    !(await storageMatches(server, familyId)) ||
    apiClient.getEndpoint() !== server
  ) {
    return STALE_SESSION_RESULT;
  }
  if (res.error) {
    return {
      ok: false,
      errorCode: res.error.code,
      retryAfter: res.error.retryAfter,
      errorMessage: safeErrorText(res.error.message, "驗證失敗，請重試"),
    };
  }
  const authToken = res.data?.authToken;
  if (authToken) {
    apiClient.setAuthToken(authToken);
    await storeIssuedToken(authToken, res.data?.expiresAt, server);
  }
  // A successful re-verification proves the credentials are valid again, so a
  // leftover recovery cooldown must not throttle the next silent refresh.
  await browser.storage.local.remove(RECOVERY_COOLDOWN_UNTIL_KEY);
  onSuccess?.();
  return { ok: true };
}

/** Tear down the local binding after a CORRECT secret met a family-gone code (else the prompt loops
 *  for the 6h tombstone); `errorCode` goes to `onFamilyRemoved`. docs/architecture.md → 重新驗證視窗. */
async function tearDownGoneFamily(
  apiClient: ApiClient,
  errorCode: string,
): Promise<void> {
  try {
    await clearFamilyStorage();
  } catch (err) {
    // Can reject (unguarded storage.local.remove); swallowed so a storage failure never strands
    // the latch, which would mute every later 401 this session.
    console.warn("[Reauth] Family teardown storage clear failed", err);
    // The stored endpoint is what the NEXT boot restores, so it must not keep the ex-family's
    // server (never rejects). See docs/architecture.md → 重新驗證視窗.
    await resetFamilyEndpointChoice();
  } finally {
    // The 401 path already nulled the token; repeated because this hook owns
    // the client's state (and `onFamilyRemoved` below is optional).
    apiClient.setAuthToken(null);
    // Release the latch BEFORE handing over: while it is set every later 401
    // skips silent recovery, so a stale one would mute re-auth for good.
    apiClient.clearReauthPending();
    // Last, so the dialog only flips to onboarding once storage and the client
    // are already consistent with "this user has no family".
    apiClient.onFamilyRemoved?.({ errorCode });
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
      const server = apiClient.getEndpoint();
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
          // No stored identity to re-join with, so no prompt: release the client's latch, or every
          // later 401 skips recovery and no re-auth prompt ever appears again.
          apiClient.clearReauthPending();
          return;
        }

        // Seed with the code that blocked recovery (a locked user sees the countdown at once);
        // anything else falls back to VERIFICATION_REQUIRED, which fetches the method.
        const blocked = isVerificationError(info?.errorCode) ? info : undefined;
        await verifyBegin(
          blocked?.errorCode ?? "VERIFICATION_REQUIRED",
          {
            userId,
            retry: (verifySecret) =>
              runReauthJoin(
                apiClient,
                server,
                familyId,
                userId,
                displayName,
                verifySecret,
                onSuccess,
              ),
            // Cancel only closes the prompt (main view stays); releasing the latch lets a later
            // authenticated action re-trigger the challenge.
            onCancel: () => {
              apiClient.clearReauthPending();
            },
            // The gate answers before the server's kicked-tombstone check, so a
            // removed member reaches this verdict only after passing it.
            onFamilyGone: (errorCode) =>
              tearDownGoneFamily(apiClient, errorCode),
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
