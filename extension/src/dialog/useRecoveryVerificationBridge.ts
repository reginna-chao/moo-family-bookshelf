/** The shared bridge that hands a verification-gated onboarding flow to the verification prompt. */

import { useCallback } from "react";
import type { ApiClient } from "../api/client";
import {
  isVerificationError,
  type UseVerificationPromptResult,
} from "./useVerificationPrompt";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";
import { STALE_SESSION_CODE, STALE_SESSION_MESSAGE } from "./verificationCodes";

/** Fallback when a verified join is refused for good (deleted / full / removed by the owner) and an
 *  older or self-hosted backend sent no message; the server normally explains the reason. */
const FAMILY_GONE_FALLBACK_MESSAGE = "無法加入此家庭，請聯繫家庭管理者確認。";

export interface RecoveryVerificationBridgeOptions {
  apiClient: Pick<ApiClient, "getEndpoint">;
  verifyBegin: UseVerificationPromptResult["begin"];
  setState: OnboardingFlowStore["setState"];
  showRetryableError: (message: string) => void;
}

// apiClient and setState sit in the deps only because they arrive as arguments; both are
// identity-stable for the Dialog's lifetime, so the memoisation is unchanged.
export function useRecoveryVerificationBridge({
  apiClient,
  verifyBegin,
  setState,
  showRetryableError,
}: RecoveryVerificationBridgeOptions) {
  /** For every gated flow (start, create, sync-code join, auto/solo recovery): a verification code opens
   *  the prompt with a retry re-running the flow. True = prompt took over; false = caller handles it. */
  const promptRecoveryVerification = useCallback(
    async (params: {
      errorCode: string | undefined;
      /** Seconds to wait, from the originating 429 (drives the countdown). */
      retryAfter?: number;
      userId: string;
      run: (verifySecret: string) => Promise<{
        recovered: boolean;
        errorCode?: string;
        errorMessage?: string;
        retryAfter?: number;
      }>;
      onCancel: () => void;
      /** Ends the attempt when the verified join is refused for good; defaults to the retryable error
       *  view. handleJoin passes its own to release the adopted `@host` before any actionable screen. */
      onFamilyGone?: (message: string) => void;
    }): Promise<boolean> => {
      if (!isVerificationError(params.errorCode)) return false;
      // Where the prompt opened: no secret leaves once the client has moved off it
      // (docs/architecture.md → 重新驗證視窗).
      const server = apiClient.getEndpoint();
      setState("verify-prompt");
      await verifyBegin(
        params.errorCode,
        {
          userId: params.userId,
          // `run`'s outcome, shaped for the controller.
          retry: async (secret) => {
            if (apiClient.getEndpoint() !== server) {
              return {
                ok: false,
                errorCode: STALE_SESSION_CODE,
                errorMessage: STALE_SESSION_MESSAGE,
              };
            }
            const result = await params.run(secret);
            return {
              ok: result.recovered,
              errorCode: result.errorCode,
              errorMessage: result.errorMessage,
              retryAfter: result.retryAfter,
            };
          },
          onCancel: params.onCancel,
          // Nothing local to clear (a family persists only on a join). Only the manual join
          // (`PerformJoinFailure`) carries a server message; `RecoveryResult` paths get the fallback.
          onFamilyGone: (_errorCode, errorMessage) => {
            const message = errorMessage ?? FAMILY_GONE_FALLBACK_MESSAGE;
            (params.onFamilyGone ?? showRetryableError)(message);
          },
          // `run` may enter a progress state ("recovering", …) hiding the open prompt behind the overlay;
          // the controller calls this on every failed attempt (throws too) while the session is live.
          onAttemptFailed: () => setState("verify-prompt"),
        },
        params.retryAfter,
      );
      return true;
    },
    [apiClient, verifyBegin, showRetryableError, setState],
  );

  return promptRecoveryVerification;
}

/** The bridge callback, as handed to each onboarding flow sub-hook. */
export type PromptRecoveryVerification = ReturnType<
  typeof useRecoveryVerificationBridge
>;
