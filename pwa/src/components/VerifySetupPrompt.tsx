import { useState, useEffect, useCallback } from "react";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import { ApiClient, type VerifyMethod } from "@/api/client";
import { PinInput } from "@/components/PinInput";
import { PatternLock } from "@/components/PatternLock";
import { CurrentSecretStep } from "@/components/CurrentSecretStep";
import {
  ChooseMethodView,
  ConfirmSkipView,
  KeepOrChangeView,
} from "@/components/VerifySetupViews";
import { useVerifyMethodSave } from "@/hooks/useVerifyMethodSave";
import { readVerifyMethod, recoverStepUp } from "@/hooks/stepUp";

interface VerifySetupPromptProps {
  userId: string;
  apiClient: ApiClient;
  onComplete: () => void;
  /** Gets the token a new pin / pattern rotated (#378); the caller persists it. */
  onTokenRotated?: (authToken: string) => void;
}

type Step =
  | "loading"
  | "keep-or-change"
  | "current-secret"
  | "choose"
  | "setup-pin"
  | "setup-pattern"
  | "confirm-skip"
  | "done";

export function VerifySetupPrompt({
  userId,
  apiClient,
  onComplete,
  onTokenRotated,
}: VerifySetupPromptProps) {
  const [step, setStep] = useState<Step>("loading");
  // The account's PIN / pattern and the secret entered for it (#396): state only, cleared once sent.
  const [stepUpMethod, setStepUpMethod] = useState<VerifyMethod | null>(null);
  const [currentSecret, setCurrentSecret] = useState<string | undefined>();
  const { saving, saveError, setSaveError, saveMethod } = useVerifyMethodSave({
    userId,
    apiClient,
    onTokenRotated,
  });

  useEffect(() => {
    void Promise.all([
      apiClient.getVerifyPrompted(userId),
      readVerifyMethod(apiClient, userId),
    ])
      .then(([res, method]) => {
        // Show only on an explicit "not yet prompted"; an error envelope (e.g. an old server's 404) skips it
        if (res.data?.prompted !== BoolFlag.FALSE) {
          setStep("done");
          return;
        }
        // A failed method read counts as "none": the server still asks for the secret if it must.
        if (method !== null && requiresCurrentSecret(method)) {
          setStepUpMethod(method);
          setStep("keep-or-change");
          return;
        }
        setStep("choose");
      })
      .catch(() => {
        // On error, skip prompt to avoid blocking the user
        setStep("done");
      });
  }, [userId, apiClient]);

  /** A refused save; `asked` is the method whose current secret was sent (null: none was). */
  const settleSaveFailure = useCallback(
    async (code: string | undefined, asked: VerifyMethod | null) => {
      if (code === "VERIFICATION_FAILED" || code === "VERIFICATION_REQUIRED") {
        const next = await recoverStepUp(apiClient, userId, { code }, asked);
        if (next?.kind === "ask") {
          setStepUpMethod(next.method);
          setSaveError(next.error);
          setStep("current-secret");
          return;
        }
        setSaveError(next?.error ?? "儲存失敗，請重試。");
        return;
      }
      // The sent secret is spent: enter it again (the save already set the error copy).
      if (asked !== null) setStep("current-secret");
    },
    [apiClient, userId, setSaveError],
  );

  const submit = useCallback(
    async (method: VerifyMethod, secret?: string) => {
      const asked = currentSecret === undefined ? null : stepUpMethod;
      const result = await saveMethod(method, secret, currentSecret);
      setCurrentSecret(undefined);
      if (result.ok) {
        onComplete();
        return;
      }
      await settleSaveFailure(result.code, asked);
    },
    [currentSecret, stepUpMethod, saveMethod, onComplete, settleSaveFailure],
  );

  const handleCurrentSecret = useCallback(
    (secret: string) => {
      setCurrentSecret(secret);
      setSaveError("");
      setStep("choose");
    },
    [setSaveError],
  );

  const handleDismiss = useCallback(async () => {
    // Just mark as prompted without setting a method
    await apiClient.markVerifyPrompted(userId);
    onComplete();
  }, [userId, apiClient, onComplete]);

  const backTo = (next: Step) => {
    setStep(next);
    setSaveError("");
  };

  if (step === "loading" || step === "done") return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl mx-6 max-w-sm w-full p-6">
        {saveError && (
          <p role="alert" className="text-red-500 text-sm mb-3 text-center">
            {saveError}
          </p>
        )}

        {step === "keep-or-change" && (
          <KeepOrChangeView
            onChange={() => backTo("current-secret")}
            onKeep={handleDismiss}
            saving={saving}
          />
        )}

        {step === "current-secret" && stepUpMethod !== null && (
          <CurrentSecretStep
            method={stepUpMethod}
            purpose="change"
            onComplete={handleCurrentSecret}
            error={saveError}
            onCancel={() => backTo("keep-or-change")}
            disabled={saving}
          />
        )}

        {step === "choose" && (
          <ChooseMethodView
            onSelectPin={() => setStep("setup-pin")}
            onSelectPattern={() => setStep("setup-pattern")}
            onSelectCode={() => void submit("code")}
            onSelectNone={() => setStep("confirm-skip")}
            onDismiss={handleDismiss}
            saving={saving}
          />
        )}

        {step === "setup-pin" && (
          <PinInput
            mode="setup"
            onComplete={(pin) => void submit("pin", pin)}
            error={saveError}
            onCancel={() => backTo("choose")}
          />
        )}

        {step === "setup-pattern" && (
          <PatternLock
            mode="setup"
            onComplete={(pattern) => void submit("pattern", pattern)}
            error={saveError}
            onCancel={() => backTo("choose")}
          />
        )}

        {step === "confirm-skip" && (
          <ConfirmSkipView
            onConfirm={() => void submit("none")}
            onBack={() => setStep("choose")}
            saving={saving}
          />
        )}
      </div>
    </div>
  );
}
