import { useCallback, useEffect, useRef, useState } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import type { ApiClient } from "../api/client";
import type { ApiErrorPayload, VerifyMethod } from "../api/types";
import { saveVerifyMethod } from "./saveVerifyMethod";
import { recoverStepUp } from "./stepUp";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface UseVerifyMethodFlowOptions {
  userId: string;
  apiClient: ApiClient;
}

/**
 * VerificationSettings' method flow: load the current method, pick a new one,
 * and save it. A PIN / pattern account first enters its current secret (#396);
 * that secret lives only in this hook's state and is cleared once sent.
 */
export function useVerifyMethodFlow({
  userId,
  apiClient,
}: UseVerifyMethodFlowOptions) {
  const [currentMethod, setCurrentMethod] = useState<VerifyMethod | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [showNoneWarning, setShowNoneWarning] = useState(false);
  const [askingSecret, setAskingSecret] = useState(false);
  const [currentSecret, setCurrentSecret] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  /** Pending "saved" → "idle" reset; cleared on unmount and before rescheduling. */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSavedTimer = useCallback(() => {
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
  }, []);

  useEffect(() => clearSavedTimer, [clearSavedTimer]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const result = await apiClient.getVerifyMethod(userId);
      if (cancelled) return;
      setCurrentMethod(result.data ? result.data.method : "none");
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, apiClient]);

  const askForCurrentSecret = useCallback((error: string) => {
    setShowSetup(false);
    setShowNoneWarning(false);
    setSaveState(error ? "error" : "idle");
    setSaveError(error);
    setAskingSecret(true);
  }, []);

  /** A refused save; `asked` is the method whose current secret was sent (null: none was). */
  const settleSaveError = useCallback(
    async (error: ApiErrorPayload, asked: VerifyMethod | null) => {
      const next = await recoverStepUp(apiClient, userId, error, asked);
      if (next?.kind === "ask") {
        setCurrentMethod(next.method);
        askForCurrentSecret(next.error);
        return;
      }
      const message =
        next?.error ?? safeErrorText(error.message, "儲存失敗，請重試");
      // The sent secret is spent, so ask again — unless the server no longer wants one.
      if (asked !== null && error.code !== "VERIFICATION_REQUIRED") {
        askForCurrentSecret(message);
        return;
      }
      setSaveState("error");
      setSaveError(message);
    },
    [apiClient, userId, askForCurrentSecret],
  );

  const handleSave = useCallback(
    async (method: VerifyMethod, secret?: string, current?: string) => {
      // A new save supersedes any pending saved→idle reset: letting the old timer
      // fire mid-flight would drop saveState out of "saving" (and out of "error").
      clearSavedTimer();
      setSaveState("saving");
      setSaveError("");
      const asked = current === undefined ? null : currentMethod;
      const result = await saveVerifyMethod(
        apiClient,
        userId,
        method,
        secret,
        current,
      );
      setCurrentSecret(undefined);
      if (result.error) {
        await settleSaveError(result.error, asked);
        return;
      }
      setCurrentMethod(method);
      setSelectedMethod(null);
      setShowSetup(false);
      setShowNoneWarning(false);
      setSaveState("saved");
      clearSavedTimer();
      savedTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
    },
    [userId, apiClient, currentMethod, settleSaveError, clearSavedTimer],
  );

  /** The step after a method is picked (and, for a PIN / pattern account, its secret entered). */
  const openMethodStep = useCallback(
    (method: VerifyMethod, current?: string) => {
      if (method === "pin" || method === "pattern") {
        setShowSetup(true);
        setShowNoneWarning(false);
        return;
      }
      if (method === "none") {
        setShowSetup(false);
        setShowNoneWarning(true);
        return;
      }
      // "code" — save immediately (no secret needed)
      setShowSetup(false);
      setShowNoneWarning(false);
      void handleSave(method, undefined, current);
    },
    [handleSave],
  );

  const handleMethodSelect = useCallback(
    (method: VerifyMethod) => {
      setSelectedMethod(method);
      setSaveState("idle");
      setSaveError("");
      setCurrentSecret(undefined);
      setAskingSecret(false);
      if (currentMethod !== null && requiresCurrentSecret(currentMethod)) {
        askForCurrentSecret("");
        return;
      }
      openMethodStep(method);
    },
    [currentMethod, askForCurrentSecret, openMethodStep],
  );

  const handleCurrentSecret = useCallback(
    (secret: string) => {
      setAskingSecret(false);
      setCurrentSecret(secret);
      setSaveState("idle");
      setSaveError("");
      if (selectedMethod !== null) openMethodStep(selectedMethod, secret);
    },
    [selectedMethod, openMethodStep],
  );

  return {
    currentMethod,
    selectedMethod,
    saveState,
    setSaveState,
    saveError,
    setSaveError,
    showSetup,
    showNoneWarning,
    askingSecret,
    currentSecret,
    loading,
    clearSavedTimer,
    handleSave,
    handleMethodSelect,
    handleCurrentSecret,
  };
}
