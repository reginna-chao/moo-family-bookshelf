/**
 * useOnboardingFlow — owns the state machine, handlers, and business state
 * for the Onboarding dialog. Keeps Onboarding.tsx focused on rendering and
 * lightweight UI chrome state (copied flag, hasUsedBefore).
 *
 * This module only wires the pieces together. The sub-hooks are called
 * unconditionally and in a fixed order that reproduces the original single
 * hook's call sequence: state + refs + effects, navigation, the verification
 * bridge, the single attempts, then the start / create / join flows and the
 * recovery-view handlers.
 */

import { useVerificationPrompt } from "./useVerificationPrompt";
import type {
  UseOnboardingFlowOptions,
  UseOnboardingFlowResult,
} from "./onboardingFlowTypes";
import { useOnboardingFlowState } from "./useOnboardingFlowState";
import { useOnboardingNavigation } from "./useOnboardingNavigation";
import { useRecoveryVerificationBridge } from "./useRecoveryVerificationBridge";
import { useOnboardingAttempts } from "./useOnboardingAttempts";
import { useOnboardingStartFlow } from "./useOnboardingStartFlow";
import { useOnboardingCreateFlow } from "./useOnboardingCreateFlow";
import { useOnboardingJoinFlow } from "./useOnboardingJoinFlow";
import { useOnboardingRecoveryHandlers } from "./useOnboardingRecoveryHandlers";

export type {
  OnboardingState,
  UseOnboardingFlowOptions,
  UseOnboardingFlowResult,
} from "./onboardingFlowTypes";

export function useOnboardingFlow(
  opts: UseOnboardingFlowOptions,
): UseOnboardingFlowResult {
  const { apiClient, onFamilyJoined, autoSetup } = opts;

  const verify = useVerificationPrompt(apiClient);
  // Stable reference for hook deps (verify.begin is useCallback-memoized).
  const verifyBegin = verify.begin;

  const store = useOnboardingFlowState(apiClient);
  const { handleRetry, showError, showRetryableError, backToRecoveryChoice } =
    useOnboardingNavigation(store, autoSetup);
  const promptRecoveryVerification = useRecoveryVerificationBridge({
    verifyBegin,
    setState: store.setState,
    showRetryableError,
  });
  const { attemptRecovery, attemptCreate } = useOnboardingAttempts(store, {
    apiClient,
    autoSetup,
    onFamilyJoined,
  });
  const handleStart = useOnboardingStartFlow({
    store,
    apiClient,
    autoSetup,
    attemptRecovery,
    backToRecoveryChoice,
    showError,
    promptRecoveryVerification,
  });
  const handleCreate = useOnboardingCreateFlow({
    store,
    apiClient,
    attemptRecovery,
    attemptCreate,
    backToRecoveryChoice,
    showError,
    showRetryableError,
    promptRecoveryVerification,
  });
  const flowDeps = {
    store,
    apiClient,
    autoSetup,
    onFamilyJoined,
    showRetryableError,
    promptRecoveryVerification,
  };
  const { handleJoin, handleContinueAfterCreate } =
    useOnboardingJoinFlow(flowDeps);
  const recovery = useOnboardingRecoveryHandlers(flowDeps);

  return {
    state: store.state,
    errorMessage: store.errorMessage,
    errorActions: store.errorActions,
    userEmail: store.userEmail,
    userDisplayName: store.userDisplayName,
    syncCodeInput: store.syncCodeInput,
    setSyncCodeInput: store.setSyncCodeInput,
    generatedSyncCode: store.generatedSyncCode,
    createdFamilyId: store.createdFamilyId,
    createdUserId: store.createdUserId,
    handleStart,
    handleCreate,
    handleJoin,
    handleContinueAfterCreate,
    handleRetry,
    handleRecoveryChoiceUseSyncCode: recovery.handleRecoveryChoiceUseSyncCode,
    handleRecoveryChoiceSkip: recovery.handleRecoveryChoiceSkip,
    handleRecoveryJoinBack: recovery.handleRecoveryJoinBack,
    handleSoloRecoveryConfirm: recovery.handleSoloRecoveryConfirm,
    handleSoloRecoveryBack: recovery.handleSoloRecoveryBack,
    verify,
  };
}
