import { useState, useEffect, useCallback } from "react";
import { ApiClient } from "@/api/client";
import type { VerifyMethod, VerifyInfo } from "@/api/client";
import { PinInput } from "@/components/PinInput";
import { PatternLock } from "@/components/PatternLock";

interface VerifySetupPromptProps {
  userId: string;
  apiClient: ApiClient;
  onComplete: () => void;
}

type Step = "loading" | "choose" | "setup-pin" | "setup-pattern" | "confirm-skip" | "done";

export function VerifySetupPrompt({ userId, apiClient, onComplete }: VerifySetupPromptProps) {
  const [step, setStep] = useState<Step>("loading");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    void apiClient.getVerifyMethod(userId).then((res) => {
      const info: VerifyInfo | undefined = res.data;
      // Only show prompt if not yet prompted
      if (info && info.prompted === 0) {
        setStep("choose");
      } else {
        setStep("done");
      }
    }).catch(() => {
      // On error, skip prompt to avoid blocking the user
      setStep("done");
    });
  }, [userId, apiClient]);

  const saveMethod = useCallback(
    async (method: VerifyMethod, secret?: string) => {
      setSaving(true);
      setSaveError("");
      const body: { method: VerifyMethod; secret?: string } = { method };
      if (secret) body.secret = secret;
      const res = await apiClient.setVerifyMethod(userId, body);
      if (res.error) {
        setSaveError(res.error.message || "儲存失敗，請重試。");
        setSaving(false);
        return false;
      }
      // Mark as prompted
      await apiClient.markVerifyPrompted(userId);
      setSaving(false);
      return true;
    },
    [userId, apiClient],
  );

  const handlePinComplete = useCallback(
    async (pin: string) => {
      const ok = await saveMethod("pin", pin);
      if (ok) onComplete();
    },
    [saveMethod, onComplete],
  );

  const handlePatternComplete = useCallback(
    async (pattern: string) => {
      const ok = await saveMethod("pattern", pattern);
      if (ok) onComplete();
    },
    [saveMethod, onComplete],
  );

  const handleChooseCode = useCallback(async () => {
    const ok = await saveMethod("code");
    if (ok) onComplete();
  }, [saveMethod, onComplete]);

  const handleSkipConfirm = useCallback(async () => {
    const ok = await saveMethod("none");
    if (ok) onComplete();
  }, [saveMethod, onComplete]);

  const handleDismiss = useCallback(async () => {
    // Just mark as prompted without setting a method
    await apiClient.markVerifyPrompted(userId);
    onComplete();
  }, [userId, apiClient, onComplete]);

  if (step === "loading" || step === "done") return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl mx-6 max-w-sm w-full p-6">
        {saveError && (
          <p role="alert" className="text-red-500 text-sm mb-3 text-center">
            {saveError}
          </p>
        )}

        {step === "choose" && (
          <ChooseMethodView
            onSelectPin={() => setStep("setup-pin")}
            onSelectPattern={() => setStep("setup-pattern")}
            onSelectCode={handleChooseCode}
            onSelectNone={() => setStep("confirm-skip")}
            onDismiss={handleDismiss}
            saving={saving}
          />
        )}

        {step === "setup-pin" && (
          <PinInput
            mode="setup"
            onComplete={(pin) => void handlePinComplete(pin)}
            error={saveError}
            onCancel={() => { setStep("choose"); setSaveError(""); }}
          />
        )}

        {step === "setup-pattern" && (
          <PatternLock
            mode="setup"
            onComplete={(pattern) => void handlePatternComplete(pattern)}
            error={saveError}
            onCancel={() => { setStep("choose"); setSaveError(""); }}
          />
        )}

        {step === "confirm-skip" && (
          <ConfirmSkipView
            onConfirm={handleSkipConfirm}
            onBack={() => setStep("choose")}
            saving={saving}
          />
        )}
      </div>
    </div>
  );
}

interface ChooseMethodViewProps {
  onSelectPin: () => void;
  onSelectPattern: () => void;
  onSelectCode: () => void;
  onSelectNone: () => void;
  onDismiss: () => void;
  saving: boolean;
}

function ChooseMethodView({
  onSelectPin,
  onSelectPattern,
  onSelectCode,
  onSelectNone,
  onDismiss,
  saving,
}: ChooseMethodViewProps) {
  return (
    <>
      <h2 className="text-lg font-bold text-gray-900 mb-2">設定登入驗證</h2>
      <p className="text-sm text-gray-500 mb-3">
        保護你的帳號，防止他人在手機版未經授權登入。
      </p>
      <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-5 leading-relaxed">
        提示：此驗證僅用於手機版登入時保護你的書櫃資料。
      </p>
      <div className="space-y-3">
        <button
          type="button"
          onClick={onSelectPin}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <span className="font-medium text-gray-900">PIN 碼</span>
          <span className="block text-xs text-gray-500 mt-0.5">6-12 位數字</span>
        </button>
        <button
          type="button"
          onClick={onSelectPattern}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <span className="font-medium text-gray-900">圖形驗證</span>
          <span className="block text-xs text-gray-500 mt-0.5">九宮格</span>
        </button>
        <button
          type="button"
          onClick={() => void onSelectCode()}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <span className="font-medium text-gray-900">隨機驗證碼</span>
          <span className="block text-xs text-gray-500 mt-0.5">需要電腦</span>
        </button>
        <button
          type="button"
          onClick={onSelectNone}
          disabled={saving}
          className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
        >
          <span className="font-medium text-gray-500">不設定驗證</span>
        </button>
      </div>
      <button
        type="button"
        onClick={() => void onDismiss()}
        disabled={saving}
        className="mt-4 w-full text-center text-sm text-gray-400 hover:text-gray-600 transition-colors"
      >
        之後再說
      </button>
    </>
  );
}

interface ConfirmSkipViewProps {
  onConfirm: () => void;
  onBack: () => void;
  saving: boolean;
}

function ConfirmSkipView({ onConfirm, onBack, saving }: ConfirmSkipViewProps) {
  return (
    <>
      <h2 className="text-lg font-bold text-gray-900 mb-3">確定不設定驗證？</h2>
      <p className="text-sm text-gray-600 leading-relaxed mb-6">
        家庭成員若知道你的 Email，可能在手機版登入你的帳號。確定不設定驗證嗎？
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-2.5 font-medium hover:bg-gray-50 transition-colors"
        >
          返回
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={saving}
          className="flex-1 bg-red-500 text-white rounded-lg py-2.5 font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
        >
          {saving ? "儲存中..." : "確定不設定"}
        </button>
      </div>
    </>
  );
}
