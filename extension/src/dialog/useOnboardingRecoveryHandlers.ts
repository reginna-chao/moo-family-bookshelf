/** Handlers behind the recovery views: recovery-choice, recovery-join and solo-recovery-confirm. */

import { useCallback } from "react";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import { performSoloRecovery } from "./onboardingFlow";
import type { UseOnboardingFlowOptions } from "./onboardingFlowTypes";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";
import type { PromptRecoveryVerification } from "./useRecoveryVerificationBridge";

export interface OnboardingRecoveryHandlersOptions extends UseOnboardingFlowOptions {
  store: OnboardingFlowStore;
  showRetryableError: (message: string) => void;
  promptRecoveryVerification: PromptRecoveryVerification;
}

// Store setters/refs sit in the deps only because they arrive as arguments; being identity-stable,
// every callback memoises exactly as it did inside useOnboardingFlow.
export function useOnboardingRecoveryHandlers(
  opts: OnboardingRecoveryHandlersOptions,
) {
  const { store, apiClient, autoSetup, onFamilyJoined } = opts;
  const { showRetryableError, promptRecoveryVerification } = opts;
  const { setState, setErrorMessage, setErrorActions, setSyncCodeInput } =
    store;
  const { userEmailRef, userDisplayNameRef, recoveryFamilyIdRef } = store;

  const handleRecoveryChoiceUseSyncCode = useCallback(() => {
    setSyncCodeInput("");
    setState("recovery-join");
  }, [setSyncCodeInput, setState]);

  const handleRecoveryChoiceSkip = useCallback(async () => {
    const email = userEmailRef.current;
    const familyId = recoveryFamilyIdRef.current;
    if (!email || !familyId) {
      setState("solo-recovery-confirm");
      return;
    }

    // Try direct solo recovery
    setState("recovering");
    try {
      const userId = await deriveUserId(email);
      const solo = await performSoloRecovery({
        familyId,
        userId,
        displayName: userDisplayNameRef.current,
        apiClient,
        autoSetup,
        onFamilyJoined,
      });
      if (solo.recovered) return;
      const handled = await promptRecoveryVerification({
        errorCode: solo.errorCode,
        retryAfter: solo.retryAfter,
        userId,
        run: (verifySecret) =>
          performSoloRecovery({
            familyId,
            userId,
            displayName: userDisplayNameRef.current,
            apiClient,
            autoSetup,
            onFamilyJoined,
            verifySecret,
          }),
        onCancel: () => setState("solo-recovery-confirm"),
      });
      if (handled) return;
    } catch {
      // Solo recovery failed — fall through to confirmation
    }

    setState("solo-recovery-confirm");
  }, [
    apiClient,
    autoSetup,
    onFamilyJoined,
    promptRecoveryVerification,
    userEmailRef,
    recoveryFamilyIdRef,
    userDisplayNameRef,
    setState,
  ]);

  const handleRecoveryJoinBack = useCallback(() => {
    setState("recovery-choice");
  }, [setState]);

  const handleSoloRecoveryBack = useCallback(() => {
    setState("recovery-choice");
  }, [setState]);

  const handleSoloRecoveryConfirm = useCallback(async () => {
    const email = userEmailRef.current;
    const familyId = recoveryFamilyIdRef.current;
    if (!email || !familyId) {
      showRetryableError("恢復資料遺失，請重新開始。");
      return;
    }
    setState("recovering");
    setErrorMessage("");
    setErrorActions([]);
    try {
      const userId = await deriveUserId(email);
      const solo = await performSoloRecovery({
        familyId,
        userId,
        displayName: userDisplayNameRef.current,
        apiClient,
        autoSetup,
        onFamilyJoined,
      });
      if (solo.recovered) return;
      const handled = await promptRecoveryVerification({
        errorCode: solo.errorCode,
        retryAfter: solo.retryAfter,
        userId,
        run: (verifySecret) =>
          performSoloRecovery({
            familyId,
            userId,
            displayName: userDisplayNameRef.current,
            apiClient,
            autoSetup,
            onFamilyJoined,
            verifySecret,
          }),
        onCancel: () => setState("solo-recovery-confirm"),
      });
      if (handled) return;
      showRetryableError("恢復失敗，請重試。");
    } catch (err) {
      showRetryableError(err instanceof Error ? err.message : "發生未知錯誤");
    }
  }, [
    apiClient,
    autoSetup,
    onFamilyJoined,
    promptRecoveryVerification,
    showRetryableError,
    userEmailRef,
    recoveryFamilyIdRef,
    userDisplayNameRef,
    setState,
    setErrorMessage,
    setErrorActions,
  ]);

  return {
    handleRecoveryChoiceUseSyncCode,
    handleRecoveryChoiceSkip,
    handleRecoveryJoinBack,
    handleSoloRecoveryBack,
    handleSoloRecoveryConfirm,
  };
}
