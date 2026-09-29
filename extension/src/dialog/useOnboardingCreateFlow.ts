/** The onboarding create flow: look up the family, then recover into it or create a new one (handleCreate). */

import { useCallback } from "react";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import type { RecoveryResult } from "./onboardingFlow";
import { lookupFamily } from "./onboardingLookup";
import type { UseOnboardingFlowOptions } from "./onboardingFlowTypes";
import type { OnboardingAttempts } from "./useOnboardingAttempts";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";
import type { useOnboardingNavigation } from "./useOnboardingNavigation";
import type { PromptRecoveryVerification } from "./useRecoveryVerificationBridge";

/** Shown when the user backs out of the verification prompt during create. The
 *  gate blocked either the lookup (family membership unknown) or the create
 *  itself, so the normal onboarding screen would invite the user to fork a
 *  second family instead of finishing the one attempt they started. */
const VERIFY_CANCELLED_MESSAGE = "需要完成驗證才能建立家庭書櫃，請重試。";

type Navigation = ReturnType<typeof useOnboardingNavigation>;

export interface OnboardingCreateFlowOptions extends OnboardingAttempts {
  store: OnboardingFlowStore;
  apiClient: UseOnboardingFlowOptions["apiClient"];
  backToRecoveryChoice: Navigation["backToRecoveryChoice"];
  showError: Navigation["showError"];
  showRetryableError: Navigation["showRetryableError"];
  promptRecoveryVerification: PromptRecoveryVerification;
}

// The store's setters and refs appear in the dependency arrays below only
// because they arrive as arguments; they are identity-stable, so every
// callback is memoised exactly as when it lived in useOnboardingFlow.
export function useOnboardingCreateFlow(opts: OnboardingCreateFlowOptions) {
  const { store, apiClient, attemptCreate, attemptRecovery } = opts;
  const { backToRecoveryChoice, showError, showRetryableError } = opts;
  const { promptRecoveryVerification } = opts;
  const { setState, setErrorMessage, setErrorActions } = store;
  const { userEmailRef, userDisplayNameRef, handleCreateRef } = store;

  /** Resume handleCreate once the user cleared the lookup challenge: re-run the
   *  lookup with the secret, then recover into the family it reveals — or
   *  create a new one, carrying the same secret. */
  const resumeCreateAfterVerification = useCallback(
    async (userId: string, verifySecret: string): Promise<RecoveryResult> => {
      const lookup = await lookupFamily({ apiClient, userId, verifySecret });
      if (!lookup.ok) {
        return {
          recovered: false,
          errorCode: lookup.errorCode,
          retryAfter: lookup.retryAfter,
        };
      }
      const { existingFamilyId, memberCount } = lookup.data;
      if (existingFamilyId && memberCount > 0) {
        return attemptRecovery({
          familyId: existingFamilyId,
          userId,
          displayName: userDisplayNameRef.current,
          verifySecret,
        });
      }
      const created = await attemptCreate(userId, verifySecret);
      if (created.ok) return { recovered: true };
      return {
        recovered: false,
        errorCode: created.errorCode,
        retryAfter: created.retryAfter,
      };
    },
    [apiClient, attemptCreate, attemptRecovery, userDisplayNameRef],
  );

  /** Cancel handler for the verification gate in handleCreate. The generic 重試
   *  action leads back to the "create or join a family" screen, which invites a
   *  second family; re-run the create flow instead so the user lands back on the
   *  challenge that 「請重試」 promises here. */
  const cancelCreateVerification = useCallback(() => {
    showError(VERIFY_CANCELLED_MESSAGE, [
      {
        label: "重新驗證",
        variant: "primary",
        onClick: () => void handleCreateRef.current?.(),
      },
    ]);
  }, [showError, handleCreateRef]);

  const handleCreate = useCallback(async () => {
    const email = userEmailRef.current;
    if (!email) return;
    setState("creating");
    setErrorMessage("");
    setErrorActions([]);

    try {
      const userId = await deriveUserId(email);
      const lookup = await lookupFamily({ apiClient, userId });

      if (!lookup.ok) {
        // Verification-enabled account: prompt, then resume with the unlocked
        // lookup (recover into the existing family, or create a new one).
        const handled = await promptRecoveryVerification({
          errorCode: lookup.errorCode,
          retryAfter: lookup.retryAfter,
          userId,
          run: (verifySecret) =>
            resumeCreateAfterVerification(userId, verifySecret),
          onCancel: cancelCreateVerification,
        });
        if (!handled) showRetryableError("無法驗證帳號，請重試。");
        return;
      }

      const { existingFamilyId, memberCount } = lookup.data;

      // User already belongs to a family — attempt recovery.
      if (existingFamilyId && memberCount > 0) {
        const recovery = await attemptRecovery({
          familyId: existingFamilyId,
          userId,
          displayName: userDisplayNameRef.current,
        });
        if (recovery.recovered) return;
        const handled = await promptRecoveryVerification({
          errorCode: recovery.errorCode,
          retryAfter: recovery.retryAfter,
          userId,
          run: (verifySecret) =>
            attemptRecovery({
              familyId: existingFamilyId,
              userId,
              displayName: userDisplayNameRef.current,
              verifySecret,
            }),
          onCancel: backToRecoveryChoice,
        });
        if (handled) return;
        // Auto-recovery failed — let the user choose how to proceed.
        backToRecoveryChoice();
        return;
      }

      const created = await attemptCreate(userId);
      if (created.ok) return;

      // Create refused pending verification (e.g. verification switched on
      // after the lookup) — prompt and retry the create with the secret.
      const handled = await promptRecoveryVerification({
        errorCode: created.errorCode,
        retryAfter: created.retryAfter,
        userId,
        run: async (verifySecret) => {
          const retry = await attemptCreate(userId, verifySecret);
          if (retry.ok) return { recovered: true };
          return {
            recovered: false,
            errorCode: retry.errorCode,
            retryAfter: retry.retryAfter,
          };
        },
        onCancel: cancelCreateVerification,
      });
      if (!handled) showRetryableError(created.errorMessage);
    } catch (err) {
      showRetryableError(err instanceof Error ? err.message : "發生未知錯誤");
    }
  }, [
    apiClient,
    attemptCreate,
    attemptRecovery,
    backToRecoveryChoice,
    cancelCreateVerification,
    promptRecoveryVerification,
    resumeCreateAfterVerification,
    showRetryableError,
    userEmailRef,
    userDisplayNameRef,
    setState,
    setErrorMessage,
    setErrorActions,
  ]);

  // Published for cancelCreateVerification, which is defined (and captured by
  // handleCreate's deps) above. Kept fresh on every render.
  handleCreateRef.current = handleCreate;

  return handleCreate;
}
