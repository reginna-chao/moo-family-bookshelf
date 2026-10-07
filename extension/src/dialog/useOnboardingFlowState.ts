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
  /** Latest state (synced by an effect) so handleRetry tells "on a recovery view" (→ welcome) from
   *  "error inside a recovery flow" (→ recovery-choice). */
  const stateRef = useRef<OnboardingState>("welcome");
  /** Set on first entering recovery-choice, so handleRetry can return there after a mid-recovery
   *  error even though stateRef is now "error". */
  const recoveryActiveRef = useRef(false);
  /** Mirrors handleStart: cancelStartVerification re-runs the lookup challenge yet is a dependency
   *  of handleStart, and the ref breaks that cycle without duplicating or reordering the flow. */
  const handleStartRef = useRef<(() => Promise<void>) | null>(null);
  /** Mirrors handleCreate likewise: cancelCreateVerification re-runs the create flow (re-opening
   *  the challenge) yet is a dependency of handleCreate. */
  const handleCreateRef = useRef<(() => Promise<void>) | null>(null);

  userEmailRef.current = userEmail;
  userDisplayNameRef.current = userDisplayName;
  syncCodeInputRef.current = syncCodeInput;
  createdFamilyIdRef.current = createdFamilyId;
  createdUserIdRef.current = createdUserId;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // A storage.sync familyId remnant (local one lost) pre-fills the sync code for a one-tap rejoin —
  // pre-fill ONLY, never auto-submit; the functional update never clobbers typing.
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
