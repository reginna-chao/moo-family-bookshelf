/** Onboarding view-navigation primitives: retry, the generic error view, and the hand-back to recovery-choice. */

import { useCallback } from "react";
// Type-only: see the note in onboardingFlowTypes.ts on the OnboardingViews loop.
import type { ErrorAction } from "./OnboardingViews";
import type {
  OnboardingState,
  UseOnboardingFlowOptions,
} from "./onboardingFlowTypes";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";

/** States where the user is actively on a recovery-flow view. */
const RECOVERY_STATES = new Set<OnboardingState>([
  "recovery-choice",
  "recovery-join",
  "solo-recovery-confirm",
]);

// Store setters/refs sit in the deps only because they arrive as arguments; being identity-stable,
// every callback memoises exactly as it did inside useOnboardingFlow.
export function useOnboardingNavigation(
  store: OnboardingFlowStore,
  autoSetup: UseOnboardingFlowOptions["autoSetup"],
) {
  const {
    setState,
    setErrorMessage,
    setErrorActions,
    stateRef,
    recoveryActiveRef,
    userEmailRef,
  } = store;

  const handleRetry = useCallback(() => {
    autoSetup.reset();
    if (RECOVERY_STATES.has(stateRef.current)) {
      // User is on a recovery view directly — restart from welcome.
      // Clear the recovery flag so subsequent errors don't loop back here.
      recoveryActiveRef.current = false;
      setState("welcome");
    } else if (recoveryActiveRef.current) {
      // User hit an error mid-recovery-flow — return to the recovery-choice screen.
      setState("recovery-choice");
    } else {
      setState(userEmailRef.current ? "idle" : "welcome");
    }
    setErrorMessage("");
    setErrorActions([]);
  }, [
    autoSetup,
    stateRef,
    recoveryActiveRef,
    setState,
    userEmailRef,
    setErrorMessage,
    setErrorActions,
  ]);

  /** Show the generic error view with caller-chosen actions. */
  const showError = useCallback(
    (message: string, actions: ErrorAction[]) => {
      setErrorMessage(message);
      setErrorActions(actions);
      setState("error");
    },
    [setErrorMessage, setErrorActions, setState],
  );

  /** Show the generic error view with a single "retry" action. */
  const showRetryableError = useCallback(
    (message: string) => {
      showError(message, [
        { label: "重試", variant: "primary", onClick: handleRetry },
      ]);
    },
    [handleRetry, showError],
  );

  /** Hand the user back to the recovery-choice screen, arming handleRetry so a
   *  later error returns here rather than to the welcome screen. */
  const backToRecoveryChoice = useCallback(() => {
    recoveryActiveRef.current = true;
    setState("recovery-choice");
  }, [recoveryActiveRef, setState]);

  return { handleRetry, showError, showRetryableError, backToRecoveryChoice };
}
