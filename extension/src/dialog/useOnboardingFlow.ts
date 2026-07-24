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
  createNewFamily,
  performJoin,
  performSoloRecovery,
  tryAutoRecovery,
} from "./onboardingFlow";
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

  /**
   * Shared bridge for the recovery flows (auto-recovery + solo recovery): if a
   * failed join carried a verification error code, open the verification prompt
   * (state → "verify-prompt") and wire up a retry that re-runs the same flow
   * with the collected secret. Returns true when the prompt took over so the
   * caller can stop; false to fall back to its own error handling.
   */
  const promptRecoveryVerification = useCallback(
    async (params: {
      errorCode: string | undefined;
      userId: string;
      run: (
        verifySecret: string,
      ) => Promise<{ recovered: boolean; errorCode?: string }>;
      onCancel: () => void;
    }): Promise<boolean> => {
      if (!isVerificationError(params.errorCode)) return false;
      setState("verify-prompt");
      await verifyBegin(params.errorCode, {
        userId: params.userId,
        retry: async (secret) => {
          const result = await params.run(secret);
          return { ok: result.recovered, errorCode: result.errorCode };
        },
        onCancel: params.onCancel,
      });
      return true;
    },
    [verifyBegin],
  );

  const handleStart = useCallback(async () => {
    const result = await autoSetup.scrapeProfile();
    if (!result) return;

    setUserEmail(result.email);
    setUserDisplayName(result.displayName);

    // Look up existing family; attempt auto-recovery or show recovery-choice.
    try {
      const userId = await deriveUserId(result.email);
      const lookupRes = await apiClient.lookupUser(userId);
      if (!lookupRes.error && lookupRes.data) {
        const { existingFamilyId, memberCount } = lookupRes.data;
        if (existingFamilyId && memberCount > 0) {
          recoveryFamilyIdRef.current = existingFamilyId;

          // Attempt auto-recovery directly (no key needed anymore)
          setState("recovering");
          const recovery = await tryAutoRecovery({
            familyId: existingFamilyId,
            userId,
            displayName: result.displayName,
            apiClient,
            autoSetup,
            onFamilyJoined,
          });
          if (recovery.recovered) return;
          const backToChoice = () => {
            recoveryActiveRef.current = true;
            setState("recovery-choice");
          };
          // Verification-enabled member on a new device: prompt for the secret
          // and retry, instead of silently dropping to the generic screen.
          const handled = await promptRecoveryVerification({
            errorCode: recovery.errorCode,
            userId,
            run: (verifySecret) =>
              tryAutoRecovery({
                familyId: existingFamilyId,
                userId,
                displayName: result.displayName,
                apiClient,
                autoSetup,
                onFamilyJoined,
                verifySecret,
              }),
            onCancel: backToChoice,
          });
          if (handled) return;
          // Auto-recovery attempted but failed (e.g. backend join error).
          // Surface the recovery-choice screen so the user can decide.
          backToChoice();
          return;
        }
      }
    } catch {
      // Recovery failed — fall through to normal onboarding
    }

    setState("idle");
  }, [apiClient, autoSetup, onFamilyJoined, promptRecoveryVerification]);

  const handleCreate = useCallback(async () => {
    const email = userEmailRef.current;
    if (!email) return;
    setState("creating");
    setErrorMessage("");
    setErrorActions([]);

    try {
      const userId = await deriveUserId(email);
      const lookupRes = await apiClient.lookupUser(userId);
      if (lookupRes.error) {
        setErrorMessage("無法驗證帳號，請重試。");
        setErrorActions([
          { label: "重試", variant: "primary", onClick: handleRetry },
        ]);
        setState("error");
        return;
      }
      const existingFamilyId = lookupRes.data?.existingFamilyId ?? null;
      const memberCount = lookupRes.data?.memberCount ?? 0;

      // User already belongs to a family — attempt recovery.
      if (existingFamilyId && memberCount > 0) {
        recoveryFamilyIdRef.current = existingFamilyId;

        setState("recovering");
        const recovery = await tryAutoRecovery({
          familyId: existingFamilyId,
          userId,
          displayName: userDisplayNameRef.current,
          apiClient,
          autoSetup,
          onFamilyJoined,
        });
        if (recovery.recovered) return;
        const backToChoice = () => {
          recoveryActiveRef.current = true;
          setState("recovery-choice");
        };
        const handled = await promptRecoveryVerification({
          errorCode: recovery.errorCode,
          userId,
          run: (verifySecret) =>
            tryAutoRecovery({
              familyId: existingFamilyId,
              userId,
              displayName: userDisplayNameRef.current,
              apiClient,
              autoSetup,
              onFamilyJoined,
              verifySecret,
            }),
          onCancel: backToChoice,
        });
        if (handled) return;
        // Auto-recovery failed — let the user choose how to proceed.
        backToChoice();
        return;
      }

      const created = await createNewFamily({
        userId,
        displayName: userDisplayNameRef.current,
        apiClient,
      });

      setGeneratedSyncCode(created.syncCode);
      setCreatedFamilyId(created.familyId);
      setCreatedUserId(created.userId);
      setState("created");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "發生未知錯誤");
      setErrorActions([
        { label: "重試", variant: "primary", onClick: handleRetry },
      ]);
      setState("error");
    }
  }, [
    apiClient,
    autoSetup,
    handleRetry,
    onFamilyJoined,
    promptRecoveryVerification,
  ]);

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
      // retry the same join with it, rather than failing the sync code.
      if (isVerificationError(result.errorCode)) {
        setState("verify-prompt");
        await verifyBegin(result.errorCode, {
          userId,
          retry: async (verifySecret) => {
            const retryResult = await performJoin({
              syncCodeInput: syncCodeInputRef.current,
              userId,
              displayName: userDisplayNameRef.current,
              apiClient,
              verifySecret,
            });
            if (retryResult.ok) {
              await finishJoin(retryResult.familyId, retryResult.userId);
              return { ok: true };
            }
            return { ok: false, errorCode: retryResult.errorCode };
          },
          onCancel: () => {
            setState(recoveryActiveRef.current ? "recovery-join" : "idle");
          },
        });
        return;
      }

      setErrorMessage(result.errorMessage);
      setErrorActions([
        { label: "重試", variant: "primary", onClick: handleRetry },
      ]);
      setState("error");
    } catch (err) {
      if (err instanceof SyncCodeError) {
        setErrorMessage(`同步碼格式錯誤：${err.message}`);
      } else {
        setErrorMessage(err instanceof Error ? err.message : "發生未知錯誤");
      }
      setErrorActions([
        { label: "重試", variant: "primary", onClick: handleRetry },
      ]);
      setState("error");
    }
  }, [apiClient, handleRetry, finishJoin, verifyBegin]);

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
      setErrorMessage("恢復資料遺失，請重新開始。");
      setErrorActions([
        { label: "重試", variant: "primary", onClick: handleRetry },
      ]);
      setState("error");
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
      setErrorMessage("恢復失敗，請重試。");
      setErrorActions([
        { label: "重試", variant: "primary", onClick: handleRetry },
      ]);
      setState("error");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "發生未知錯誤");
      setErrorActions([
        { label: "重試", variant: "primary", onClick: handleRetry },
      ]);
      setState("error");
    }
  }, [
    apiClient,
    autoSetup,
    handleRetry,
    onFamilyJoined,
    promptRecoveryVerification,
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
