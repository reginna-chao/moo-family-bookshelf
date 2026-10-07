/** The onboarding start flow: scrape the profile, look up the family, and recover into it (handleStart). */

import { useCallback } from "react";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import type { RecoveryResult } from "./onboardingFlow";
import { lookupFamily } from "./onboardingLookup";
import type { UseOnboardingFlowOptions } from "./onboardingFlowTypes";
import type { OnboardingAttempts } from "./useOnboardingAttempts";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";
import type { useOnboardingNavigation } from "./useOnboardingNavigation";
import type { PromptRecoveryVerification } from "./useRecoveryVerificationBridge";

/** Shown on backing out of start's lookup challenge: the family data was withheld, so the normal
 *  screen would wrongly tell a user who has a family that they have none. */
const START_VERIFY_CANCELLED_MESSAGE =
  "需要完成驗證才能讀取你的家庭資料，請重試。";

type Navigation = ReturnType<typeof useOnboardingNavigation>;

export interface OnboardingStartFlowOptions {
  store: OnboardingFlowStore;
  apiClient: UseOnboardingFlowOptions["apiClient"];
  autoSetup: UseOnboardingFlowOptions["autoSetup"];
  attemptRecovery: OnboardingAttempts["attemptRecovery"];
  backToRecoveryChoice: Navigation["backToRecoveryChoice"];
  showError: Navigation["showError"];
  promptRecoveryVerification: PromptRecoveryVerification;
}

// Store setters/refs sit in the deps only because they arrive as arguments; being identity-stable,
// every callback memoises exactly as it did inside useOnboardingFlow.
export function useOnboardingStartFlow(opts: OnboardingStartFlowOptions) {
  const { store, apiClient, autoSetup, attemptRecovery } = opts;
  const { backToRecoveryChoice, showError, promptRecoveryVerification } = opts;
  const { setState, setUserEmail, setUserDisplayName } = store;
  const { recoveryFamilyIdRef, handleStartRef } = store;

  /** Resume handleStart once the user cleared the lookup challenge: re-run the
   *  lookup with the secret, then recover into the family it reveals. */
  const resumeStartAfterVerification = useCallback(
    async (params: {
      userId: string;
      displayName: string;
      verifySecret: string;
    }): Promise<RecoveryResult> => {
      const lookup = await lookupFamily({
        apiClient,
        userId: params.userId,
        verifySecret: params.verifySecret,
      });
      if (!lookup.ok) {
        return {
          recovered: false,
          errorCode: lookup.errorCode,
          retryAfter: lookup.retryAfter,
        };
      }
      const { existingFamilyId, memberCount } = lookup.data;
      if (!existingFamilyId || memberCount <= 0) {
        // Verified, but there is nothing to recover — continue as a new user.
        setState("idle");
        return { recovered: true };
      }
      return attemptRecovery({
        familyId: existingFamilyId,
        userId: params.userId,
        displayName: params.displayName,
        verifySecret: params.verifySecret,
      });
    },
    [apiClient, attemptRecovery, setState],
  );

  /** Cancel for handleStart's lookup challenge: recovery-choice once a family is known; otherwise the
   *  familyId was withheld, so an error instead of the screen claiming there is no family. */
  const cancelStartVerification = useCallback(() => {
    if (recoveryFamilyIdRef.current) {
      backToRecoveryChoice();
      return;
    }
    // The generic 重試 leads to "create or join" — the very misreading this prevents — so re-run the
    // lookup challenge, as 「請重試」 promises.
    showError(START_VERIFY_CANCELLED_MESSAGE, [
      {
        label: "重新驗證",
        variant: "primary",
        onClick: () => void handleStartRef.current?.(),
      },
    ]);
  }, [backToRecoveryChoice, showError, recoveryFamilyIdRef, handleStartRef]);

  const handleStart = useCallback(async () => {
    const result = await autoSetup.scrapeProfile();
    if (!result) return;

    setUserEmail(result.email);
    setUserDisplayName(result.displayName);

    // Look up existing family; attempt auto-recovery or show recovery-choice.
    try {
      const userId = await deriveUserId(result.email);
      const lookup = await lookupFamily({ apiClient, userId });

      // Verification-enabled account: the lookup withholds the family data
      // until the user proves ownership of this (publicly guessable) userId.
      if (!lookup.ok) {
        const handled = await promptRecoveryVerification({
          errorCode: lookup.errorCode,
          retryAfter: lookup.retryAfter,
          userId,
          run: (verifySecret) =>
            resumeStartAfterVerification({
              userId,
              displayName: result.displayName,
              verifySecret,
            }),
          onCancel: cancelStartVerification,
        });
        if (handled) return;
      } else if (lookup.data.existingFamilyId && lookup.data.memberCount > 0) {
        const { existingFamilyId } = lookup.data;
        // Attempt auto-recovery directly (no key needed anymore)
        const recovery = await attemptRecovery({
          familyId: existingFamilyId,
          userId,
          displayName: result.displayName,
        });
        if (recovery.recovered) return;
        // Verification-enabled member on a new device: prompt for the secret
        // and retry, instead of silently dropping to the generic screen.
        const handled = await promptRecoveryVerification({
          errorCode: recovery.errorCode,
          retryAfter: recovery.retryAfter,
          userId,
          run: (verifySecret) =>
            attemptRecovery({
              familyId: existingFamilyId,
              userId,
              displayName: result.displayName,
              verifySecret,
            }),
          onCancel: backToRecoveryChoice,
        });
        if (handled) return;
        // Auto-recovery attempted but failed (e.g. backend join error).
        // Surface the recovery-choice screen so the user can decide.
        backToRecoveryChoice();
        return;
      }
    } catch {
      // Recovery failed — fall through to normal onboarding
    }

    setState("idle");
  }, [
    apiClient,
    attemptRecovery,
    autoSetup,
    backToRecoveryChoice,
    cancelStartVerification,
    promptRecoveryVerification,
    resumeStartAfterVerification,
    setUserEmail,
    setUserDisplayName,
    setState,
  ]);

  // Published for cancelStartVerification, which is defined (and captured by
  // handleStart's deps) above. Kept fresh on every render.
  handleStartRef.current = handleStart;

  return handleStart;
}
