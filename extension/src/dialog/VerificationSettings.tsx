import type { ApiClient } from "../api/client";
import type { VerifyMethod } from "../api/types";
import { OtpCodeFrame, PatternFrame, PinFrame } from "../secureFrame/frames";
import { CurrentSecretStep } from "./CurrentSecretStep";
import { ForgotSecretHint } from "./ForgotSecretHint";
import { useOtpCode } from "./useOtpCode";
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

  const { otpCode, otpCountdown, resetOtp, handleGenerateOtp } = useOtpCode({
    userId,
    apiClient,
    clearSavedTimer,
    setSaveState,
    setSaveError,
  });

  const handleMethodSelect = (method: VerifyMethod) => {
    resetOtp();
    flow.handleMethodSelect(method);
  };

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
        PIN 碼或圖形。
      </div>
      <ForgotSecretHint apiClient={apiClient} />

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
        <PinFrame
          mode="setup"
          onComplete={(pin) => void handleSave("pin", pin, currentSecret)}
          error={stepError}
        />
      )}

      {/* Pattern setup */}
      {showSetup && selectedMethod === "pattern" && (
        <PatternFrame
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
              <OtpCodeFrame code={otpCode} />
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
