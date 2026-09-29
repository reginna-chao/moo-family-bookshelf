/** useOnboardingFlow's state: rendered values, their fresh-value refs, and the two mount-time effects. */

import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import { encodeSyncCode } from "../crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "../constants";
import { readSyncFamilyIdRemnant } from "../storage/familyId";
// Type-only: see the note in onboardingFlowTypes.ts on the OnboardingViews loop.
import type { ErrorAction } from "./OnboardingViews";
import type { OnboardingState } from "./onboardingFlowTypes";

export function useOnboardingFlowState(apiClient: ApiClient) {
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

  return {
    state,
    setState,
    errorMessage,
    setErrorMessage,
    errorActions,
    setErrorActions,
    userEmail,
    setUserEmail,
    userDisplayName,
    setUserDisplayName,
    syncCodeInput,
    setSyncCodeInput,
    generatedSyncCode,
    setGeneratedSyncCode,
    createdFamilyId,
    setCreatedFamilyId,
    createdUserId,
    setCreatedUserId,
    userEmailRef,
    userDisplayNameRef,
    syncCodeInputRef,
    createdFamilyIdRef,
    createdUserIdRef,
    recoveryFamilyIdRef,
    stateRef,
    recoveryActiveRef,
    handleStartRef,
    handleCreateRef,
  };
}

/** Everything useOnboardingFlowState owns; the flow sub-hooks read from it. */
export type OnboardingFlowStore = ReturnType<typeof useOnboardingFlowState>;
