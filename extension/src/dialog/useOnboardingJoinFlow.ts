/** The onboarding join flow (handleJoin) and the two hand-offs into the main view after a join or a create. */

import { useCallback } from "react";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import { SyncCodeError } from "../crypto/syncCode";
import { performJoin, restoreApiEndpoint } from "./onboardingFlow";
import type { UseOnboardingFlowOptions } from "./onboardingFlowTypes";
import type { OnboardingFlowStore } from "./useOnboardingFlowState";
import type { PromptRecoveryVerification } from "./useRecoveryVerificationBridge";

export interface OnboardingJoinFlowOptions extends UseOnboardingFlowOptions {
  store: OnboardingFlowStore;
  showRetryableError: (message: string) => void;
  promptRecoveryVerification: PromptRecoveryVerification;
}

// The store's setters and refs appear in the dependency arrays below only
// because they arrive as arguments; they are identity-stable, so every
// callback is memoised exactly as when it lived in useOnboardingFlow.
export function useOnboardingJoinFlow(opts: OnboardingJoinFlowOptions) {
  const { store, apiClient, autoSetup, onFamilyJoined } = opts;
  const { showRetryableError, promptRecoveryVerification } = opts;
  const { setState, setErrorMessage, setErrorActions } = store;
  const { userEmailRef, userDisplayNameRef, syncCodeInputRef } = store;
  const { recoveryActiveRef, createdFamilyIdRef, createdUserIdRef } = store;

  const finishJoin = useCallback(
    async (familyId: string, userId: string) => {
      // Auto-sync books after joining; sync is best-effort, proceed regardless.
      setState("syncing-books");
      await autoSetup.syncBooks({ userId, apiClient });
      onFamilyJoined(familyId, userId);
    },
    [apiClient, autoSetup, onFamilyJoined, setState],
  );

  const handleJoin = useCallback(async () => {
    const email = userEmailRef.current;
    if (!email) return;
    setState("joining");
    setErrorMessage("");
    setErrorActions([]);

    // This scope owns the sync code's `@host` for the whole attempt. performJoin
    // applies it (the join must go there) and persists it only once a join
    // succeeds; it deliberately leaves it applied on failure, because the
    // verification challenge below is a continuation of the same attempt — it
    // queries that server for the account's verification method and retries the
    // join against it. Every exit that ends the attempt WITHOUT a join hands the
    // endpoint back: otherwise a code whose server answered "no" would keep
    // steering this client, and the 建立家庭 the user reaches for next would ship
    // the userId, the token it issues and the whole book list there.
    const endpointBeforeAttempt = apiClient.getEndpoint();
    let joined = false;
    const abandonAttempt = () => {
      if (joined) return;
      restoreApiEndpoint(apiClient, endpointBeforeAttempt);
    };

    try {
      const userId = await deriveUserId(email);
      const result = await performJoin({
        syncCodeInput: syncCodeInputRef.current,
        userId,
        displayName: userDisplayNameRef.current,
        apiClient,
      });

      if (result.ok) {
        joined = true;
        await finishJoin(result.familyId, result.userId);
        return;
      }

      // Verification-enabled member reconnecting: prompt for the secret and
      // retry the same join with it, rather than failing the sync code. Goes
      // through the shared bridge so the prompt-restore guard applies here too.
      const handled = await promptRecoveryVerification({
        errorCode: result.errorCode,
        retryAfter: result.retryAfter,
        userId,
        run: async (verifySecret) => {
          const retryResult = await performJoin({
            syncCodeInput: syncCodeInputRef.current,
            userId,
            displayName: userDisplayNameRef.current,
            apiClient,
            verifySecret,
          });
          if (!retryResult.ok) {
            return {
              recovered: false,
              errorCode: retryResult.errorCode,
              errorMessage: retryResult.errorMessage,
              retryAfter: retryResult.retryAfter,
            };
          }
          joined = true;
          await finishJoin(retryResult.familyId, retryResult.userId);
          return { recovered: true };
        },
        onCancel: () => {
          // Walking away from the challenge ends the attempt — give the
          // endpoint back before the user is on an actionable screen again.
          abandonAttempt();
          setState(recoveryActiveRef.current ? "recovery-join" : "idle");
        },
        // A verified join the family refuses for good also ends the attempt, so
        // the sync code's `@host` must be handed back here too — otherwise the
        // rejected server would still be in force when the user presses 建立家庭.
        onFamilyGone: (message) => {
          abandonAttempt();
          showRetryableError(message);
        },
      });
      // The prompt now owns the attempt: it either joins (persisting the
      // endpoint), or ends via onCancel above.
      if (handled) return;

      abandonAttempt();
      showRetryableError(result.errorMessage);
    } catch (err) {
      abandonAttempt();
      if (err instanceof SyncCodeError) {
        showRetryableError(`同步碼格式錯誤：${err.message}`);
        return;
      }
      showRetryableError(err instanceof Error ? err.message : "發生未知錯誤");
    }
  }, [
    apiClient,
    showRetryableError,
    finishJoin,
    promptRecoveryVerification,
    userEmailRef,
    syncCodeInputRef,
    userDisplayNameRef,
    recoveryActiveRef,
    setState,
    setErrorMessage,
    setErrorActions,
  ]);

  const handleContinueAfterCreate = useCallback(async () => {
    setState("syncing-books");
    // Book sync is best-effort; regardless of success we proceed to the main
    // view because the family itself was created successfully.
    await autoSetup.syncBooks({
      userId: createdUserIdRef.current,
      apiClient,
    });
    onFamilyJoined(createdFamilyIdRef.current, createdUserIdRef.current);
  }, [
    apiClient,
    autoSetup,
    onFamilyJoined,
    setState,
    createdUserIdRef,
    createdFamilyIdRef,
  ]);

  return { handleJoin, handleContinueAfterCreate };
}
