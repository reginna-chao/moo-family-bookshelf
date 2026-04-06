import React, { useState, useRef, useCallback } from "react";

export interface PinInputProps {
  onComplete: (pin: string) => void;
  mode: "setup" | "verify";
  error?: string;
  /** Number of digits (4-6). Defaults to 4. */
  length?: number;
}

type SetupStep = "enter" | "confirm";

export function PinInput({ onComplete, mode, error, length = 4 }: PinInputProps) {
  const [digits, setDigits] = useState<string[]>(Array(length).fill(""));
  const [setupStep, setSetupStep] = useState<SetupStep>("enter");
  const [firstPin, setFirstPin] = useState("");
  const [mismatchError, setMismatchError] = useState("");
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const resetDigits = useCallback(() => {
    setDigits(Array(length).fill(""));
    inputRefs.current[0]?.focus();
  }, [length]);

  const handleDigitChange = useCallback(
    (index: number, value: string) => {
      if (!/^\d?$/.test(value)) return;

      const updated = [...digits];
      updated[index] = value;
      setDigits(updated);
      setMismatchError("");

      if (value && index < length - 1) {
        inputRefs.current[index + 1]?.focus();
        return;
      }

      if (!value) return;

      const pin = updated.join("");
      if (pin.length < length || updated.some((d) => d === "")) return;

      if (mode === "verify") {
        onComplete(pin);
        return;
      }

      // Setup mode
      if (setupStep === "enter") {
        setFirstPin(pin);
        setSetupStep("confirm");
        setDigits(Array(length).fill(""));
        setTimeout(() => inputRefs.current[0]?.focus(), 0);
        return;
      }

      // Confirm step
      if (pin === firstPin) {
        onComplete(pin);
      } else {
        setMismatchError("PIN 碼不一致，請重新輸入");
        setDigits(Array(length).fill(""));
        setTimeout(() => inputRefs.current[0]?.focus(), 0);
      }
    },
    [digits, length, mode, setupStep, firstPin, onComplete],
  );

  const handleKeyDown = useCallback(
    (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Backspace" && !digits[index] && index > 0) {
        inputRefs.current[index - 1]?.focus();
      }
    },
    [digits],
  );

  const displayError = error ?? mismatchError;
  const label =
    mode === "verify"
      ? "請輸入 PIN 碼"
      : setupStep === "enter"
        ? "設定 PIN 碼"
        : "再次輸入 PIN 碼確認";

  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 14, color: "#334155", marginBottom: 12, fontWeight: 500 }}>
        {label}
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 8 }}>
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el; }}
            type="password"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => handleDigitChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            aria-label={`PIN 第 ${i + 1} 碼`}
            style={{
              width: 44,
              height: 52,
              textAlign: "center",
              fontSize: 20,
              fontWeight: 600,
              border: `2px solid ${displayError ? "#ef4444" : digit ? "#2563eb" : "#cbd5e1"}`,
              borderRadius: 8,
              outline: "none",
              background: "#f8fafc",
            }}
          />
        ))}
      </div>
      {displayError && (
        <div style={{ color: "#ef4444", fontSize: 13, marginTop: 4 }}>{displayError}</div>
      )}
      {mode === "setup" && setupStep === "confirm" && (
        <button
          onClick={() => {
            setSetupStep("enter");
            setFirstPin("");
            resetDigits();
          }}
          style={{
            marginTop: 8, background: "transparent", border: "none",
            color: "#64748b", fontSize: 13, cursor: "pointer", textDecoration: "underline",
          }}
        >
          重新設定
        </button>
      )}
    </div>
  );
}
