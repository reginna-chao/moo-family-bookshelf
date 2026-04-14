/**
 * useOnboardingFlow — owns the state machine, handlers, and business state
 * for the Onboarding dialog. Keeps Onboarding.tsx focused on rendering and
 * lightweight UI chrome state (copied flag, hasUsedBefore).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient } from "../api/client";
import { deriveUserId } from "../crypto/encrypt";
import { SyncCodeError } from "../crypto/syncCode";
import { useAutoSetup } from "./useAutoSetup";
import type { ErrorAction } from "./OnboardingViews";
import {
  createNewFamily,
  getSyncedEncryptionKey,
  performJoin,
  performSoloRecovery,
  tryAutoRecovery,
} from "./onboardingFlow";

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
}

export function useOnboardingFlow(
  opts: UseOnboardingFlowOptions,
): UseOnboardingFlowResult {
  const { apiClient, onFamilyJoined, autoSetup } = opts;

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

  const handleStart = useCallback(async () => {
    const result = await autoSetup.scrapeProfile();
    if (!result) return;

    setUserEmail(result.email);
    setUserDisplayName(result.displayName);

    // Look up existing family; decide between silent auto-recovery and the
    // user-facing recovery-choice screen based on whether we have an
    // encryption key on this device.
    try {
      const userId = await deriveUserId(result.email);
      const lookupRes = await apiClient.lookupUser(userId);
      if (!lookupRes.error && lookupRes.data) {
        const { existingFamilyId, memberCount } = lookupRes.data;
        if (existingFamilyId && memberCount > 0) {
          recoveryFamilyIdRef.current = existingFamilyId;

          const syncedKey = await getSyncedEncryptionKey();
          if (syncedKey) {
            setState("recovering");
            const { recovered } = await tryAutoRecovery({
              familyId: existingFamilyId,
              userId,
              displayName: result.displayName,
              apiClient,
              autoSetup,
              onFamilyJoined,
            });
            if (recovered) return;
            // Auto-recovery attempted but failed (e.g. backend join error).
            // Surface the recovery-choice screen so the user can decide.
            recoveryActiveRef.current = true;
            setState("recovery-choice");
            return;
          }

          // No key on this device — show the recovery-choice screen directly
          // so the user can paste a sync code or opt into a solo rotation.
          recoveryActiveRef.current = true;
          setState("recovery-choice");
          return;
        }
      }
    } catch {
      // Recovery failed — fall through to normal onboarding
    }

    setState("idle");
  }, [apiClient, autoSetup, onFamilyJoined]);

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
        setErrorActions([{ label: "重試", variant: "primary", onClick: handleRetry }]);
        setState("error");
        return;
      }
      const existingFamilyId = lookupRes.data?.existingFamilyId ?? null;
      const memberCount = lookupRes.data?.memberCount ?? 0;

      // User already belongs to a family — decide between silent recovery
      // and the user-facing recovery-choice screen.
      if (existingFamilyId && memberCount > 0) {
        recoveryFamilyIdRef.current = existingFamilyId;

        const syncedKey = await getSyncedEncryptionKey();
        if (syncedKey) {
          setState("recovering");
          const { recovered } = await tryAutoRecovery({
            familyId: existingFamilyId,
            userId,
            displayName: userDisplayNameRef.current,
            apiClient,
            autoSetup,
            onFamilyJoined,
          });
          if (recovered) return;
        }
        // No key, or auto-recovery failed — let the user choose how to proceed.
        recoveryActiveRef.current = true;
        setState("recovery-choice");
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
      setErrorActions([{ label: "重試", variant: "primary", onClick: handleRetry }]);
      setState("error");
    }
  }, [apiClient, autoSetup, handleRetry, onFamilyJoined]);

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

      if (!result.ok) {
        if (result.errorCode === "VERIFICATION_REQUIRED") {
          setErrorMessage(
            "此家庭需要使用手機 App 完成驗證後才能加入。請先在手機 App 中登入並設定驗證，或向家人取得新的同步碼。",
          );
          setErrorActions([{ label: "我知道了", variant: "primary", onClick: handleRetry }]);
        } else {
          setErrorMessage(result.errorMessage);
          setErrorActions([{ label: "重試", variant: "primary", onClick: handleRetry }]);
        }
        setState("error");
        return;
      }

      // Auto-sync books after joining; sync is best-effort, proceed regardless
      setState("syncing-books");
      await autoSetup.syncBooks({ userId: result.userId, apiClient });
      onFamilyJoined(result.familyId, result.userId);
    } catch (err) {
      if (err instanceof SyncCodeError) {
        setErrorMessage(`同步碼格式錯誤：${err.message}`);
      } else {
        setErrorMessage(err instanceof Error ? err.message : "發生未知錯誤");
      }
      setErrorActions([{ label: "重試", variant: "primary", onClick: handleRetry }]);
      setState("error");
    }
  }, [apiClient, autoSetup, handleRetry, onFamilyJoined]);

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

  const handleRecoveryChoiceSkip = useCallback(() => {
    setState("solo-recovery-confirm");
  }, []);

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
      setErrorActions([{ label: "重試", variant: "primary", onClick: handleRetry }]);
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
      setErrorMessage("恢復失敗，請重試。");
      setErrorActions([{ label: "重試", variant: "primary", onClick: handleRetry }]);
      setState("error");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "發生未知錯誤");
      setErrorActions([{ label: "重試", variant: "primary", onClick: handleRetry }]);
      setState("error");
    }
  }, [apiClient, autoSetup, handleRetry, onFamilyJoined]);

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
  };
}
