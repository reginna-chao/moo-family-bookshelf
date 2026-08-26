import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ApiClient } from "../api/client";
import type { VerifyMethod } from "../api/types";
import { PinInput } from "./PinInput";
import { PatternLock } from "./PatternLock";

export interface VerificationSettingsProps {
  userId: string;
  apiClient: ApiClient;
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Per-method label, in the order the selection buttons render (Map preserves
 * insertion order). A Map, not an object literal: `method` arrives unvalidated
 * from a user-configurable backend, and a Map lookup never walks the prototype
 * chain, so a hostile `"__proto__"` / `"toString"` resolves to nothing instead
 * of an Object.prototype member React would refuse to render.
 */
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
  const [currentMethod, setCurrentMethod] = useState<VerifyMethod | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [showNoneWarning, setShowNoneWarning] = useState(false);
  const [loading, setLoading] = useState(true);

  // OTP state
  const [otpCode, setOtpCode] = useState<string | null>(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Pending "saved" → "idle" reset; cleared on unmount and before rescheduling. */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const result = await apiClient.getVerifyMethod(userId);
      if (cancelled) return;
      if (result.data) {
        setCurrentMethod(result.data.method);
      } else {
        setCurrentMethod("none");
      }
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, apiClient]);

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

  const handleSave = useCallback(
    async (method: VerifyMethod, secret?: string) => {
      // A new save supersedes any pending saved→idle reset: letting the old timer
      // fire mid-flight would drop saveState out of "saving" (and out of "error").
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);

      setSaveState("saving");
      setSaveError("");
      const body: { method: VerifyMethod; secret?: string } = { method };
      if (secret) body.secret = secret;
      const result = await apiClient.setVerifyMethod(userId, body);
      if (result.error) {
        setSaveState("error");
        setSaveError(result.error.message);
        return;
      }
      setCurrentMethod(method);
      setSelectedMethod(null);
      setShowSetup(false);
      setShowNoneWarning(false);
      setSaveState("saved");
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
    },
    [userId, apiClient],
  );

  const handleMethodSelect = useCallback(
    (method: VerifyMethod) => {
      setSelectedMethod(method);
      setSaveState("idle");
      setSaveError("");
      setOtpCode(null);
      setOtpExpiresAt(null);

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
      void handleSave(method);
    },
    [handleSave],
  );

  const handleGenerateOtp = useCallback(async () => {
    const result = await apiClient.generateOtp(userId);
    if (result.data) {
      setOtpCode(result.data.code);
      setOtpExpiresAt(result.data.expiresAt);
    }
  }, [userId, apiClient]);

  if (loading) {
    return <div className="moo-verify__loading">載入中...</div>;
  }

  return (
    <div className="moo-verify">
      <div className="moo-verify__title">手機版登入驗證</div>
      <div className="moo-verify__current">
        目前方式：
        {METHOD_LABELS.get(currentMethod ?? "none") ?? UNKNOWN_METHOD_LABEL}
      </div>
      <div className="moo-verify__tip">
        提示：此驗證僅用於手機版登入時保護你的書櫃資料。
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

      {/* PIN setup */}
      {showSetup && selectedMethod === "pin" && (
        <PinInput
          mode="setup"
          onComplete={(pin) => void handleSave("pin", pin)}
          error={saveState === "error" ? saveError : undefined}
        />
      )}

      {/* Pattern setup */}
      {showSetup && selectedMethod === "pattern" && (
        <PatternLock
          mode="setup"
          onComplete={(pattern) => void handleSave("pattern", pattern)}
          error={saveState === "error" ? saveError : undefined}
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
            onClick={() => void handleSave("none")}
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
      {saveState === "error" && !showSetup && (
        <div className="moo-verify__status moo-verify__status--error">
          {saveError}
        </div>
      )}
    </div>
  );
}
