import React, { useState, useRef, useCallback } from "react";

export interface PinInputProps {
  onComplete: (pin: string) => void;
  mode: "setup" | "verify";
  error?: string;
  /** When true, ignore all interaction and dim the widget (e.g. while a
   *  verification attempt is in flight). Defaults to false. */
  disabled?: boolean;
}

type SetupStep = "enter" | "confirm";

const PIN_MIN = 6;
const PIN_MAX = 12;

function validatePin(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return "PIN 碼只能包含數字";
  if (pin.length < PIN_MIN || pin.length > PIN_MAX)
    return `PIN 碼長度須為 ${PIN_MIN}-${PIN_MAX} 位數`;
  return null;
}

export function PinInput({
  onComplete,
  mode,
  error,
  disabled = false,
}: PinInputProps) {
  const [pin, setPin] = useState("");
  const [setupStep, setSetupStep] = useState<SetupStep>("enter");
  const [firstPin, setFirstPin] = useState("");
  const [localError, setLocalError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const resetInput = useCallback(() => {
    setPin("");
    inputRef.current?.focus();
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Allow only digits, up to max length
    if (value !== "" && !/^\d+$/.test(value)) return;
    if (value.length > PIN_MAX) return;
    setPin(value);
    setLocalError("");
  }, []);

  const handleSubmit = useCallback(() => {
    if (disabled) return;
    const validationError = validatePin(pin);
    if (validationError) {
      setLocalError(validationError);
      return;
    }

    if (mode === "verify") {
      onComplete(pin);
      return;
    }

    // Setup mode
    if (setupStep === "enter") {
      setFirstPin(pin);
      setSetupStep("confirm");
      setPin("");
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }

    // Confirm step
    if (pin === firstPin) {
      onComplete(pin);
    } else {
      setLocalError("PIN 碼不一致，請重新輸入");
      setPin("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [pin, mode, setupStep, firstPin, onComplete, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const displayError = error ?? localError;
  const label =
    mode === "verify"
      ? "請輸入 PIN 碼"
      : setupStep === "enter"
        ? "設定 PIN 碼"
        : "再次輸入 PIN 碼確認";

  // Border color is state-driven (error → filled → empty); the other field
  // metrics live in the .moo-pin-input__field class.
  const fieldBorderColor = displayError
    ? "#ef4444"
    : pin
      ? "#2563eb"
      : "#cbd5e1";

  return (
    <div
      className="moo-secret-entry"
      style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}
    >
      <div className="moo-secret-entry__label">{label}</div>
      <div className="moo-pin-input__hint">
        {PIN_MIN}-{PIN_MAX} 位數字
      </div>
      <div className="moo-pin-input__row">
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          aria-label="PIN 碼輸入"
          placeholder={`輸入 ${PIN_MIN}-${PIN_MAX} 位數字`}
          className="moo-pin-input__field"
          style={{ border: `2px solid ${fieldBorderColor}` }}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled}
          className="moo-button moo-pin-input__submit"
        >
          確認
        </button>
      </div>
      {displayError && (
        <div className="moo-secret-entry__error moo-secret-entry__error--tight">
          {displayError}
        </div>
      )}
      {mode === "setup" && setupStep === "confirm" && (
        <button
          onClick={() => {
            setSetupStep("enter");
            setFirstPin("");
            setLocalError("");
            resetInput();
          }}
          className="moo-button moo-button--link moo-secret-entry__reset"
        >
          重新設定
        </button>
      )}
    </div>
  );
}
