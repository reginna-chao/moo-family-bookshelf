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

const METHOD_LABELS: Record<VerifyMethod, string> = {
  pin: "PIN 碼",
  pattern: "圖形驗證",
  code: "隨機驗證碼",
  none: "不設定驗證",
};

export function VerificationSettings({ userId, apiClient }: VerificationSettingsProps) {
  const [currentMethod, setCurrentMethod] = useState<VerifyMethod | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<VerifyMethod | null>(null);
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
    return () => { cancelled = true; };
  }, [userId, apiClient]);

  // OTP countdown timer
  useEffect(() => {
    if (!otpExpiresAt) return;
    function tick() {
      const remaining = Math.max(0, Math.floor(((otpExpiresAt ?? 0) - Date.now()) / 1000));
      setOtpCountdown(remaining);
      if (remaining <= 0) {
        setOtpCode(null);
        setOtpExpiresAt(null);
        if (timerRef.current) clearInterval(timerRef.current);
      }
    }
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [otpExpiresAt]);

  const handleSave = useCallback(
    async (method: VerifyMethod, secret?: string) => {
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
      setTimeout(() => setSaveState("idle"), 2000);
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
    return (
      <div style={{ color: "#94a3b8", fontSize: 14, padding: 8 }}>載入中...</div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#64748b", marginBottom: 8 }}>
        手機版登入驗證
      </div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
        目前方式：{METHOD_LABELS[currentMethod ?? "none"]}
      </div>
      <div
        style={{
          background: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 12,
          color: "#64748b",
          lineHeight: 1.5,
          marginBottom: 12,
        }}
      >
        提示：此驗證僅用於 PWA 登入時保護你的書櫃資料。Extension 重裝後的恢復流程會透過你已登入的 Readmoo 帳號自動驗證身份，不會受此設定影響。
      </div>

      {/* Method selection buttons */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {(Object.keys(METHOD_LABELS) as VerifyMethod[]).map((method) => (
          <button
            key={method}
            onClick={() => handleMethodSelect(method)}
            disabled={saveState === "saving"}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: saveState === "saving" ? "not-allowed" : "pointer",
              border:
                (selectedMethod ?? currentMethod) === method
                  ? "2px solid #2563eb"
                  : "1px solid #e2e8f0",
              background:
                (selectedMethod ?? currentMethod) === method ? "#eff6ff" : "transparent",
              color:
                (selectedMethod ?? currentMethod) === method ? "#2563eb" : "#64748b",
            }}
          >
            {METHOD_LABELS[method]}
          </button>
        ))}
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
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8,
              padding: 12, marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 13, color: "#92400e" }}>
              家庭成員若知道你的 Email，可能在手機版登入你的帳號
            </div>
          </div>
          <button
            onClick={() => void handleSave("none")}
            disabled={saveState === "saving"}
            style={{
              padding: "8px 20px", borderRadius: 6, fontSize: 13, fontWeight: 600,
              border: "1px solid #f59e0b", background: "#fffbeb", color: "#b45309",
              cursor: saveState === "saving" ? "not-allowed" : "pointer",
            }}
          >
            {saveState === "saving" ? "儲存中..." : "確定不設定驗證"}
          </button>
        </div>
      )}

      {/* OTP display for "code" method */}
      {currentMethod === "code" && !showSetup && !showNoneWarning && (
        <div style={{ marginTop: 8 }}>
          {otpCode ? (
            <div style={{ textAlign: "center", marginBottom: 8 }}>
              <div
                style={{
                  fontSize: 24, fontWeight: 700, fontFamily: "monospace",
                  color: "#2563eb", letterSpacing: 4, marginBottom: 4,
                }}
              >
                {otpCode}
              </div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                {otpCountdown > 0 ? `${otpCountdown} 秒後過期` : "已過期"}
              </div>
            </div>
          ) : (
            <button
              onClick={() => void handleGenerateOtp()}
              style={{
                padding: "8px 20px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                border: "1px solid #2563eb", background: "#eff6ff", color: "#2563eb",
                cursor: "pointer",
              }}
            >
              產生驗證碼
            </button>
          )}
        </div>
      )}

      {/* Save status */}
      {saveState === "saving" && !showNoneWarning && (
        <div style={{ color: "#64748b", fontSize: 13, marginTop: 8 }}>儲存中...</div>
      )}
      {saveState === "saved" && (
        <div style={{ color: "#10b981", fontSize: 13, marginTop: 8 }}>已儲存</div>
      )}
      {saveState === "error" && !showSetup && (
        <div style={{ color: "#ef4444", fontSize: 13, marginTop: 8 }}>{saveError}</div>
      )}
    </div>
  );
}
