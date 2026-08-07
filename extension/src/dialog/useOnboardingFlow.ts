/**
 * useOnboardingFlow — owns the state machine, handlers, and business state
 * for the Onboarding dialog. Keeps Onboarding.tsx focused on rendering and
 * lightweight UI chrome state (copied flag, hasUsedBefore).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient } from "../api/client";
import { deriveUserId } from "../crypto/hash";
import { SyncCodeError, encodeSyncCode } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "../constants";
import { readSyncFamilyIdRemnant } from "../storage/familyId";
import { useAutoSetup } from "./useAutoSetup";
import type { ErrorAction } from "./OnboardingViews";
import {
  CreateFamilyError,
  createNewFamily,
  performJoin,
  performSoloRecovery,
  tryAutoRecovery,
  type RecoveryResult,
} from "./onboardingFlow";
import { lookupFamily } from "./onboardingLookup";
import {
  isVerificationError,
  useVerificationPrompt,
  type UseVerificationPromptResult,
} from "./useVerificationPrompt";

export type OnboardingState =
  | "welcome"
  | "idle"
  | "creating"
  | "recovering"
  | "created"
  | "joining"
  | "syncing-books"
  | "recovery-choice"
  | "recovery-join"
  | "solo-recovery-confirm"
  | "verify-prompt"
  | "error";

/** States where the user is actively on a recovery-flow view. */
const RECOVERY_STATES = new Set<OnboardingState>([
  "recovery-choice",
  "recovery-join",
  "solo-recovery-confirm",
]);

/** Shown when the user backs out of the verification prompt during create. The
 *  gate blocked either the lookup (family membership unknown) or the create
 *  itself, so the normal onboarding screen would invite the user to fork a
 *  second family instead of finishing the one attempt they started. */
const VERIFY_CANCELLED_MESSAGE = "需要完成驗證才能建立家庭書櫃，請重試。";

/** Shown when the user backs out of the lookup challenge during start. The
 *  server withheld the family data, so the normal onboarding screen would
 *  wrongly tell a user who has a family that they have none. */
const START_VERIFY_CANCELLED_MESSAGE =
  "需要完成驗證才能讀取你的家庭資料，請重試。";

/** Outcome of one create-a-family attempt, with the backend refusal as a value. */
type CreateAttempt =
  | { ok: true }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      retryAfter?: number;
    };

export interface UseOnboardingFlowOptions {
  apiClient: ApiClient;
  onFamilyJoined: (familyId: string, userId: string) => void;
  autoSetup: ReturnType<typeof useAutoSetup>;
}

export interface UseOnboardingFlowResult {
  state: OnboardingState;
  errorMessage: string;
  errorActions: ErrorAction[];
  userEmail: string | null;
  userDisplayName: string;
  syncCodeInput: string;
  setSyncCodeInput: (value: string) => void;
  generatedSyncCode: string;
  createdFamilyId: string;
  createdUserId: string;
  handleStart: () => Promise<void>;
  handleCreate: () => Promise<void>;
  handleJoin: () => Promise<void>;
  handleContinueAfterCreate: () => Promise<void>;
  handleRetry: () => void;
  /** From recovery-choice: user chose to enter a sync code → recovery-join */
  handleRecoveryChoiceUseSyncCode: () => void;
  /** From recovery-choice: user chose to skip → solo-recovery-confirm */
  handleRecoveryChoiceSkip: () => void;
  /** From recovery-join: user wants to go back to the choice screen */
  handleRecoveryJoinBack: () => void;
  /** From solo-recovery-confirm: user confirmed → runs performSoloRecovery */
  handleSoloRecoveryConfirm: () => Promise<void>;
  /** From solo-recovery-confirm: user wants to go back to the choice screen */
  handleSoloRecoveryBack: () => void;
  /** Verification challenge controller (shown when state === "verify-prompt"). */
  verify: UseVerificationPromptResult;
}

export function useOnboardingFlow(
  opts: UseOnboardingFlowOptions,
): UseOnboardingFlowResult {
  const { apiClient, onFamilyJoined, autoSetup } = opts;

  const verify = useVerificationPrompt(apiClient);
  // Stable reference for hook deps (verify.begin is useCallback-memoized).
  const verifyBegin = verify.begin;

  const [state, setState] = useState<OnboardingState>("welcome");
  const [errorMessage, setErrorMessage] = useState("");
  const [errorActions, setErrorActions] = useState<ErrorAction[]>([]);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userDisplayName, setUserDisplayName] = useState("");
  const [syncCodeInput, setSyncCodeInput] = useState("");
  const [generatedSyncCode, setGeneratedSyncCode] = useState("");
  const [createdFamilyId, setCreatedFamilyId] = useState("");
  const [createdUserId, setCreatedUserId] = useState("");

  // Refs mirror the latest state so handlers can read fresh values without
  // being recreated on every render (keeps stable identity for consumers).
  const userEmailRef = useRef<string | null>(null);
  const userDisplayNameRef = useRef("");
  const syncCodeInputRef = useRef("");
  const createdFamilyIdRef = useRef("");
  const createdUserIdRef = useRef("");
  /** Tracks the familyId discovered during lookup so the recovery-choice /
   *  solo-recovery-confirm handlers can run `performSoloRecovery` later. */
  const recoveryFamilyIdRef = useRef("");
  /** Mirrors the latest state so handleRetry can distinguish "user is currently
   *  on a recovery view" (→ welcome) from "user hit an error while in a recovery
   *  flow" (→ recovery-choice). Updated via useEffect on every state change. */
  const stateRef = useRef<OnboardingState>("welcome");
  /** Becomes true when the user first enters the recovery-choice screen.
   *  Lets handleRetry navigate back to recovery-choice after an error that
   *  occurred mid-recovery-flow, even though stateRef is now "error". */
  const recoveryActiveRef = useRef(false);
  /** Mirrors handleStart. cancelStartVerification must be able to re-run the
   *  lookup challenge, but it is itself a dependency of handleStart — a ref
   *  breaks that cycle without duplicating the flow or reordering it. */
  const handleStartRef = useRef<(() => Promise<void>) | null>(null);
  /** Mirrors handleCreate for the same reason as handleStartRef:
   *  cancelCreateVerification must re-run the create flow (which re-opens the
   *  verification challenge), but it is a dependency of handleCreate. */
  const handleCreateRef = useRef<(() => Promise<void>) | null>(null);

  userEmailRef.current = userEmail;
  userDisplayNameRef.current = userDisplayName;
  syncCodeInputRef.current = syncCodeInput;
  createdFamilyIdRef.current = createdFamilyId;
  createdUserIdRef.current = createdUserId;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Pre-fill the sync-code input from a storage.sync remnant: when this device
  // has onboarded (local userId) but lost its local familyId while sync still
  // holds one, offer the encoded sync code so the user can rejoin in one tap.
  // Pre-fill ONLY — never auto-submit; functional update avoids clobbering typing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const remnant = await readSyncFamilyIdRemnant();
      if (cancelled || !remnant) return;
      const endpoint = apiClient.getEndpoint();
      const apiHost = endpoint !== DEFAULT_API_ENDPOINT ? endpoint : undefined;
      const code = encodeSyncCode({ familyId: remnant, apiHost });
      setSyncCodeInput((current) => (current ? current : code));
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

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
  }, [autoSetup]);

  /** Show the generic error view with caller-chosen actions. */
  const showError = useCallback((message: string, actions: ErrorAction[]) => {
    setErrorMessage(message);
    setErrorActions(actions);
    setState("error");
  }, []);

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
  }, []);

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
        retryAfter?: number;
      }>;
      onCancel: () => void;
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
              retryAfter: result.retryAfter,
            };
          },
          onCancel: params.onCancel,
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
    [verifyBegin],
  );

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
    [apiClient, autoSetup, onFamilyJoined],
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
        // Unexpected failure (network / storage). Reported as a value rather
        // than rethrown: this also runs inside the verification prompt's retry
        // closure, where a rejection would leave the prompt stuck submitting.
        return {
          ok: false,
          errorCode: "UNEXPECTED_ERROR",
          errorMessage: err instanceof Error ? err.message : "發生未知錯誤",
        };
      }
    },
    [apiClient],
  );

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
    [apiClient, attemptRecovery],
  );

  /** Cancel handler for the lookup challenge in handleStart. Falls back to the
   *  recovery-choice screen once a family is known; otherwise the familyId is
   *  necessarily unknown (the server withheld it), so show an error instead of
   *  the onboarding screen that claims the user has no family. */
  const cancelStartVerification = useCallback(() => {
    if (recoveryFamilyIdRef.current) {
      backToRecoveryChoice();
      return;
    }
    // The generic 重試 action leads to the "create or join a family" screen —
    // exactly the misreading this message exists to prevent. Re-run the lookup
    // challenge instead, which is what 「請重試」 promises here.
    showError(START_VERIFY_CANCELLED_MESSAGE, [
      {
        label: "重新驗證",
        variant: "primary",
        onClick: () => void handleStartRef.current?.(),
      },
    ]);
  }, [backToRecoveryChoice, showError]);

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
  ]);

  // Published for cancelStartVerification, which is defined (and captured by
  // handleStart's deps) above. Kept fresh on every render.
  handleStartRef.current = handleStart;

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
    [apiClient, attemptCreate, attemptRecovery],
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
  }, [showError]);

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
  ]);

  // Published for cancelCreateVerification, which is defined (and captured by
  // handleCreate's deps) above. Kept fresh on every render.
  handleCreateRef.current = handleCreate;

  const finishJoin = useCallback(
    async (familyId: string, userId: string) => {
      // Auto-sync books after joining; sync is best-effort, proceed regardless.
      setState("syncing-books");
      await autoSetup.syncBooks({ userId, apiClient });
      onFamilyJoined(familyId, userId);
    },
    [apiClient, autoSetup, onFamilyJoined],
  );

  const handleJoin = useCallback(async () => {
    const email = userEmailRef.current;
    if (!email) return;
    setState("joining");
    setErrorMessage("");
    setErrorActions([]);

    try {
      const userId = await deriveUserId(email);
      const result = await performJoin({
        syncCodeInput: syncCodeInputRef.current,
        userId,
        displayName: userDisplayNameRef.current,
        apiClient,
      });

      if (result.ok) {
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
              retryAfter: retryResult.retryAfter,
            };
          }
          await finishJoin(retryResult.familyId, retryResult.userId);
          return { recovered: true };
        },
        onCancel: () => {
          setState(recoveryActiveRef.current ? "recovery-join" : "idle");
        },
      });
      if (handled) return;

      showRetryableError(result.errorMessage);
    } catch (err) {
      if (err instanceof SyncCodeError) {
        showRetryableError(`同步碼格式錯誤：${err.message}`);
        return;
      }
      showRetryableError(err instanceof Error ? err.message : "發生未知錯誤");
    }
  }, [apiClient, showRetryableError, finishJoin, promptRecoveryVerification]);

  const handleContinueAfterCreate = useCallback(async () => {
    setState("syncing-books");
    // Book sync is best-effort; regardless of success we proceed to the main
    // view because the family itself was created successfully.
    await autoSetup.syncBooks({
      userId: createdUserIdRef.current,
      apiClient,
    });
    onFamilyJoined(createdFamilyIdRef.current, createdUserIdRef.current);
  }, [apiClient, autoSetup, onFamilyJoined]);

  const handleRecoveryChoiceUseSyncCode = useCallback(() => {
    setSyncCodeInput("");
    setState("recovery-join");
  }, []);

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
  }, [apiClient, autoSetup, onFamilyJoined, promptRecoveryVerification]);

  const handleRecoveryJoinBack = useCallback(() => {
    setState("recovery-choice");
  }, []);

  const handleSoloRecoveryBack = useCallback(() => {
    setState("recovery-choice");
  }, []);

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
  ]);

  return {
    state,
    errorMessage,
    errorActions,
    userEmail,
    userDisplayName,
    syncCodeInput,
    setSyncCodeInput,
    generatedSyncCode,
    createdFamilyId,
    createdUserId,
    handleStart,
    handleCreate,
    handleJoin,
    handleContinueAfterCreate,
    handleRetry,
    handleRecoveryChoiceUseSyncCode,
    handleRecoveryChoiceSkip,
    handleRecoveryJoinBack,
    handleSoloRecoveryConfirm,
    handleSoloRecoveryBack,
    verify,
  };
}
