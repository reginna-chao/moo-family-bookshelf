/** Single onboarding attempts — rejoin a discovered family, or create one — shared by the start and create flows. */

import { useCallback } from "react";
import {
  CreateFamilyError,
  createNewFamily,
  tryAutoRecovery,
  type RecoveryResult,
} from "./onboardingFlow";
import type { UseOnboardingFlowOptions } from "./onboardingFlowTypes";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";

/** Outcome of one create-a-family attempt, with the backend refusal as a value. */
export type CreateAttempt =
  | { ok: true }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      retryAfter?: number;
    };

// Store setters/refs sit in the deps only because they arrive as arguments; being identity-stable,
// every callback memoises exactly as it did inside useOnboardingFlow.
export function useOnboardingAttempts(
  store: OnboardingFlowStore,
  { apiClient, autoSetup, onFamilyJoined }: UseOnboardingFlowOptions,
) {
  const {
    setState,
    setGeneratedSyncCode,
    setCreatedFamilyId,
    setCreatedUserId,
    userDisplayNameRef,
    recoveryFamilyIdRef,
  } = store;

  /** One attempt at rejoining a discovered family. Records the familyId for the
   *  recovery views and moves the UI into "recovering" before the request. */
  const attemptRecovery = useCallback(
    (params: {
      familyId: string;
      userId: string;
      displayName: string;
      verifySecret?: string;
    }): Promise<RecoveryResult> => {
      recoveryFamilyIdRef.current = params.familyId;
      setState("recovering");
      return tryAutoRecovery({
        familyId: params.familyId,
        userId: params.userId,
        displayName: params.displayName,
        apiClient,
        autoSetup,
        onFamilyJoined,
        verifySecret: params.verifySecret,
      });
    },
    [apiClient, autoSetup, onFamilyJoined, recoveryFamilyIdRef, setState],
  );

  /** One attempt at creating a family. Applies the success side-effects and
   *  turns the known backend refusals into a value the caller can bridge. */
  const attemptCreate = useCallback(
    async (userId: string, verifySecret?: string): Promise<CreateAttempt> => {
      try {
        const created = await createNewFamily({
          userId,
          displayName: userDisplayNameRef.current,
          apiClient,
          verifySecret,
        });
        setGeneratedSyncCode(created.syncCode);
        setCreatedFamilyId(created.familyId);
        setCreatedUserId(created.userId);
        setState("created");
        return { ok: true };
      } catch (err) {
        if (err instanceof CreateFamilyError) {
          return {
            ok: false,
            errorCode: err.code,
            errorMessage: err.message,
            retryAfter: err.retryAfter,
          };
        }
        // Unexpected failure (network / storage), returned rather than rethrown: inside the prompt's
        // retry closure a rejection would leave it stuck submitting.
        return {
          ok: false,
          errorCode: "UNEXPECTED_ERROR",
          errorMessage: err instanceof Error ? err.message : "發生未知錯誤",
        };
      }
    },
    [
      apiClient,
      userDisplayNameRef,
      setGeneratedSyncCode,
      setCreatedFamilyId,
      setCreatedUserId,
      setState,
    ],
  );

  return { attemptRecovery, attemptCreate };
}

/** The attempt callbacks, as handed to the start and create flow sub-hooks. */
export type OnboardingAttempts = ReturnType<typeof useOnboardingAttempts>;
