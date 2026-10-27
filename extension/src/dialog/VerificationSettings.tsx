import React, { useState, useEffect, useCallback, useRef } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiClient } from "../api/client";
import type { VerifyMethod } from "../api/types";
import { PinInput } from "./PinInput";
import { PatternLock } from "./PatternLock";
import { CurrentSecretStep } from "./CurrentSecretStep";
import { rateLimitedEnvelopeMessage } from "./verificationMessages";
import { useVerifyMethodFlow } from "./useVerifyMethodFlow";

export interface VerificationSettingsProps {
  userId: string;
  apiClient: ApiClient;
}

/** Per-method label in button order (a Map keeps insertion order). A Map, not an object literal: the
 *  unvalidated `method` must not resolve `"__proto__"` / `"toString"` to a member React cannot render. */
const METHOD_LABELS: ReadonlyMap<VerifyMethod, string> = new Map([
  ["pin", "PIN 碼"],
  ["pattern", "圖形驗證"],
  ["code", "隨機驗證碼"],
  ["none", "不設定驗證"],
]);

/** Shown for a method outside the union; same wording as the "none" label. */
const UNKNOWN_METHOD_LABEL = "不設定驗證";

export function VerificationSettings({
  userId,
  apiClient,
}: VerificationSettingsProps) {
  const flow = useVerifyMethodFlow({ userId, apiClient });
  const { currentMethod, selectedMethod, saveState, saveError } = flow;
  const { showSetup, showNoneWarning, askingSecret, currentSecret } = flow;
  const { clearSavedTimer, setSaveState, setSaveError, handleSave } = flow;

  // OTP state
  const [otpCode, setOtpCode] = useState<string | null>(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // OTP countdown timer
  useEffect(() => {
    if (!otpExpiresAt) return;
    function tick() {
      const remaining = Math.max(
        0,
        Math.floor(((otpExpiresAt ?? 0) - Date.now()) / 1000),
      );
      setOtpCountdown(remaining);
      if (remaining <= 0) {
        setOtpCode(null);
        setOtpExpiresAt(null);
        if (timerRef.current) clearInterval(timerRef.current);
      }
    }
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [otpExpiresAt]);

  const handleMethodSelect = (method: VerifyMethod) => {
    setOtpCode(null);
    setOtpExpiresAt(null);
    flow.handleMethodSelect(method);
  };

  const handleGenerateOtp = useCallback(async () => {
    // A new OTP generation supersedes any pending saved→idle reset: the stale
    // timer would dismiss this handler's own failure banner mid-flight.
    clearSavedTimer();

    setSaveState("idle");
    setSaveError("");
    const result = await apiClient.generateOtp(userId);
    // Bare-cast envelope: a non-string code crashes render, a non-finite expiry breaks the countdown,
    // so either fails the generation. See docs/architecture.md → 驗證碼的產生.
    const code: unknown = result.data?.code;
    const expiresAt: unknown = result.data?.expiresAt;
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt)
    ) {
      setSaveState("error");
      // A real 429 (verify-write ceiling) gets the shared back-off copy; there may be no error at
      // all, since this branch also catches a success envelope with malformed fields.
      setSaveError(
        (result.error ? rateLimitedEnvelopeMessage(result.error) : null) ??
          safeErrorText(result.error?.message, "驗證碼產生失敗，請重試"),
      );
      return;
    }
    setOtpCode(code);
    setOtpExpiresAt(expiresAt);
  }, [userId, apiClient, clearSavedTimer, setSaveState, setSaveError]);

  if (flow.loading) {
    return <div className="moo-verify__loading">載入中...</div>;
  }

  const stepError = saveState === "error" ? saveError : undefined;
  return (
    <div className="moo-verify">
      <div className="moo-verify__title">登入驗證</div>
      <div className="moo-verify__current">
        目前方式：
        {METHOD_LABELS.get(currentMethod ?? "none") ?? UNKNOWN_METHOD_LABEL}
      </div>
      <div className="moo-verify__tip">
        提示：用手機版（PWA）登入，或電腦上的擴充功能需要重新登入時，都要通過這個驗證。要改成別的方式，得先輸入目前的
        PIN 碼或圖形；忘記的話，自架伺服器請找管理者協助。
      </div>

      {/* Method selection buttons */}
      <div className="moo-verify__methods">
        {[...METHOD_LABELS.entries()].map(([method, label]) => {
          const isActive = (selectedMethod ?? currentMethod) === method;
          const methodClass = isActive
            ? "moo-verify__method moo-verify__method--active"
            : "moo-verify__method";
          return (
            <button
              key={method}
              onClick={() => handleMethodSelect(method)}
              disabled={saveState === "saving"}
              className={methodClass}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Current PIN / pattern, before any change on such an account (#396) */}
      {askingSecret && currentMethod !== null && (
        <CurrentSecretStep
          method={currentMethod}
          purpose="change"
          onComplete={flow.handleCurrentSecret}
          error={stepError}
          disabled={saveState === "saving"}
        />
      )}

      {/* PIN setup */}
      {showSetup && selectedMethod === "pin" && (
        <PinInput
          mode="setup"
          onComplete={(pin) => void handleSave("pin", pin, currentSecret)}
          error={stepError}
        />
      )}

      {/* Pattern setup */}
      {showSetup && selectedMethod === "pattern" && (
        <PatternLock
          mode="setup"
          onComplete={(p) => void handleSave("pattern", p, currentSecret)}
          error={stepError}
        />
      )}

      {/* None warning */}
      {showNoneWarning && (
        <div className="moo-verify__none-warning">
          <div className="moo-verify__none-box">
            <div className="moo-verify__none-text">
              家庭成員若知道你的 Email，可能在手機版登入你的帳號
            </div>
          </div>
          <button
            onClick={() => void handleSave("none", undefined, currentSecret)}
            disabled={saveState === "saving"}
            className="moo-button moo-button--warn moo-button--sm moo-verify__none-confirm"
          >
            {saveState === "saving" ? "儲存中..." : "確定不設定驗證"}
          </button>
        </div>
      )}

      {/* OTP display for "code" method */}
      {currentMethod === "code" && !showSetup && !showNoneWarning && (
        <div className="moo-verify__otp">
          {otpCode ? (
            <div className="moo-verify__otp-display">
              <div className="moo-verify__otp-code">{otpCode}</div>
              <div className="moo-verify__otp-countdown">
                {otpCountdown > 0 ? `${otpCountdown} 秒後過期` : "已過期"}
              </div>
            </div>
          ) : (
            <button
              onClick={() => void handleGenerateOtp()}
              className="moo-button moo-button--outline moo-button--sm moo-verify__otp-generate"
            >
              產生驗證碼
            </button>
          )}
        </div>
      )}

      {/* Save status */}
      {saveState === "saving" && !showNoneWarning && (
        <div className="moo-verify__status moo-verify__status--saving">
          儲存中...
        </div>
      )}
      {saveState === "saved" && (
        <div className="moo-verify__status moo-verify__status--saved">
          已儲存
        </div>
      )}
      {saveState === "error" && !showSetup && !askingSecret && (
        <div className="moo-verify__status moo-verify__status--error">
          {saveError}
        </div>
      )}
    </div>
  );
}
