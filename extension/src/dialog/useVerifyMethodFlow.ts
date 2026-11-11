import { useCallback, useState } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import type { ApiClient } from "../api/client";
import type { ApiErrorPayload, VerifyMethod } from "../api/types";
import { saveVerifyMethod } from "./saveVerifyMethod";
import { recoverStepUp } from "./stepUp";
import { useSavedStateTimer } from "./useSavedStateTimer";
import { useVerifyMethodSource } from "./useVerifyMethodSource";

export type SaveState = "idle" | "saving" | "saved" | "error";

export const VERIFY_SERVER_CHANGED_MESSAGE =
  "伺服器已更換，請重新設定驗證方式。";

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
  const [selectedMethod, setSelectedMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [showNoneWarning, setShowNoneWarning] = useState(false);
  const [askingSecret, setAskingSecret] = useState(false);
  const [currentSecret, setCurrentSecret] = useState<string | undefined>();
  const { clearSavedTimer, startSavedTimer } = useSavedStateTimer();
  const { currentMethod, loading, setCurrentMethod, pinSource, reload } =
    useVerifyMethodSource(apiClient, userId);

  const askForCurrentSecret = useCallback((error: string) => {
    setShowSetup(false);
    setShowNoneWarning(false);
    setSaveState(error ? "error" : "idle");
    setSaveError(error);
    setAskingSecret(true);
  }, []);

  /** Restart on the client's current server; true when the flow must stop. `force` restarts regardless. */
  const restartIfMoved = useCallback(
    (force = false) => {
      if (!force && pinSource()()) return false;
      clearSavedTimer();
      setCurrentSecret(undefined);
      setSelectedMethod(null);
      askForCurrentSecret(VERIFY_SERVER_CHANGED_MESSAGE);
      setAskingSecret(false);
      reload();
      return true;
    },
    [pinSource, reload, clearSavedTimer, askForCurrentSecret],
  );

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
    [apiClient, userId, setCurrentMethod, askForCurrentSecret],
  );

  const handleSave = useCallback(
    async (method: VerifyMethod, secret?: string, current?: string) => {
      if (restartIfMoved()) return;
      // A new save supersedes any pending saved→idle reset: letting the old timer
      // fire mid-flight would drop saveState out of "saving" (and out of "error").
      clearSavedTimer();
      setSaveState("saving");
      setSaveError("");
      const asked = current === undefined ? null : currentMethod;
      const sameSource = pinSource();
      const result = await saveVerifyMethod(
        apiClient,
        userId,
        method,
        secret,
        current,
      );
      setCurrentSecret(undefined);
      // A reply is only applied while the method's source is the one pinned above.
      if (!sameSource()) return void restartIfMoved(true);
      if (result.error) {
        await settleSaveError(result.error, asked);
        if (!sameSource()) restartIfMoved(true);
        return;
      }
      setCurrentMethod(method);
      setSelectedMethod(null);
      setShowSetup(false);
      setShowNoneWarning(false);
      setSaveState("saved");
      startSavedTimer(() => setSaveState("idle"));
    },
    [
      userId,
      apiClient,
      currentMethod,
      setCurrentMethod,
      settleSaveError,
      clearSavedTimer,
      startSavedTimer,
      restartIfMoved,
      pinSource,
    ],
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
      if (restartIfMoved()) return;
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
    [currentMethod, askForCurrentSecret, openMethodStep, restartIfMoved],
  );

  const handleCurrentSecret = useCallback(
    (secret: string) => {
      if (restartIfMoved()) return;
      setAskingSecret(false);
      setCurrentSecret(secret);
      setSaveState("idle");
      setSaveError("");
      if (selectedMethod !== null) openMethodStep(selectedMethod, secret);
    },
    [selectedMethod, openMethodStep, restartIfMoved],
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
