/** The shared bridge that hands a verification-gated onboarding flow to the verification prompt. */

import { useCallback } from "react";
import {
  isVerificationError,
  type UseVerificationPromptResult,
} from "./useVerificationPrompt";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";

/** Shown when a verified join is refused because the family is gone for this
 *  user (deleted / full / removed by the owner) and the backend sent no message
 *  of its own. The server normally explains the exact reason — this is the
 *  fallback for an older or self-hosted backend that does not. */
const FAMILY_GONE_FALLBACK_MESSAGE = "無法加入此家庭，請聯繫家庭管理者確認。";

export interface RecoveryVerificationBridgeOptions {
  verifyBegin: UseVerificationPromptResult["begin"];
  setState: OnboardingFlowStore["setState"];
  showRetryableError: (message: string) => void;
}

// setState appears in the dependency array only because it arrives as an
// argument; it is identity-stable, so the memoisation is unchanged.
export function useRecoveryVerificationBridge({
  verifyBegin,
  setState,
  showRetryableError,
}: RecoveryVerificationBridgeOptions) {
  /**
   * Shared bridge for every flow that can hit the verification gate (start,
   * create, sync-code join, auto-recovery, solo recovery): if a failed
   * lookup/join/create carried a verification code, open the verification prompt
   * (state → "verify-prompt") and wire up a retry that re-runs the same flow
   * with the collected secret. Returns true when the prompt took over so the
   * caller can stop; false to fall back to its own error handling.
   */
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
      /**
       * End the attempt when the verified join is refused for good (family
       * deleted / full / removed by the owner). Defaults to the retryable error
       * view carrying `message`; a caller holding attempt-scoped state — the
       * `@host` handleJoin adopts from the sync code — passes its own so that
       * state is released before the user is on an actionable screen again.
       */
      onFamilyGone?: (message: string) => void;
    }): Promise<boolean> => {
      if (!isVerificationError(params.errorCode)) return false;
      setState("verify-prompt");
      await verifyBegin(
        params.errorCode,
        {
          userId: params.userId,
          // Pure data transform: `run`'s outcome, shaped for the controller.
          retry: async (secret) => {
            const result = await params.run(secret);
            return {
              ok: result.recovered,
              errorCode: result.errorCode,
              errorMessage: result.errorMessage,
              retryAfter: result.retryAfter,
            };
          },
          onCancel: params.onCancel,
          // Nothing local to clear — onboarding persists a family only once a
          // join succeeds — so this branch only has to end the attempt and say
          // why. Only the manual-join path (`PerformJoinFailure`) carries the
          // server's own message today; the recovery bridges' `RecoveryResult`
          // has no `errorMessage` field, so those paths always show the client
          // fallback below.
          onFamilyGone: (_errorCode, errorMessage) => {
            const message = errorMessage ?? FAMILY_GONE_FALLBACK_MESSAGE;
            (params.onFamilyGone ?? showRetryableError)(message);
          },
          // `run` may move the flow into a progress state ("recovering",
          // "syncing-books", …), which would hide the still-open prompt behind
          // the full-screen loading overlay. The controller calls this back on
          // every failed attempt — including an unexpected throw — but only
          // while the prompt session is still live.
          onAttemptFailed: () => setState("verify-prompt"),
        },
        params.retryAfter,
      );
      return true;
    },
    [verifyBegin, showRetryableError, setState],
  );

  return promptRecoveryVerification;
}

/** The bridge callback, as handed to each onboarding flow sub-hook. */
export type PromptRecoveryVerification = ReturnType<
  typeof useRecoveryVerificationBridge
>;
