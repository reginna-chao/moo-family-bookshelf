import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  isPinComplete,
  normalizePinInput,
  pickSecretEntryError,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
} from "moo-family-bookshelf-shared/verifyInput/rules";
import {
  formatPinCounter,
  PIN_MISMATCH_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";

export interface PinInputProps {
  onComplete: (pin: string) => void;
  mode: "setup" | "verify";
  error?: string;
  /** When true, ignore all interaction and dim the widget (e.g. while a
   *  verification attempt is in flight). Defaults to false. */
  disabled?: boolean;
}

type SetupStep = "enter" | "confirm";

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
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refocus waits for the re-render that clears the field (0ms timer); re-arming clears the
  // previous timer and unmount clears a pending one instead of touching a dead ref.
  const focusInputSoon = useCallback(() => {
    if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      inputRef.current?.focus();
    }, 0);
  }, []);

  useEffect(
    () => () => {
      if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    },
    [],
  );

  const resetInput = useCallback(() => {
    setPin("");
    inputRef.current?.focus();
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = normalizePinInput(e.target.value);
    if (value === null) return;
    setPin(value);
    setLocalError("");
  }, []);

  const handleSubmit = useCallback(() => {
    if (disabled || !isPinComplete(pin)) return;

    if (mode === "verify") {
      onComplete(pin);
      return;
    }

    // Setup mode
    if (setupStep === "enter") {
      setFirstPin(pin);
      setSetupStep("confirm");
      setPin("");
      focusInputSoon();
      return;
    }

    // Confirm step
    if (pin === firstPin) {
      onComplete(pin);
    } else {
      setLocalError(PIN_MISMATCH_MESSAGE);
      setPin("");
      focusInputSoon();
    }
  }, [pin, mode, setupStep, firstPin, onComplete, disabled, focusInputSoon]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const displayError = pickSecretEntryError(localError, error);
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
    <div className="moo-secret-entry">
      {/* Only the interactive cluster dims: the error line below is the sole explanation of a
          rate-limit lock, so it stays at full opacity for the whole wait. */}
      <div
        style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}
      >
        <div className="moo-secret-entry__label">{label}</div>
        <div className="moo-pin-input__hint">
          {PIN_MIN_LENGTH}-{PIN_MAX_LENGTH} 位數字
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
            placeholder={`輸入 ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} 位數字`}
            className="moo-pin-input__field"
            style={{ border: `2px solid ${fieldBorderColor}` }}
          />
          <button
            onClick={handleSubmit}
            disabled={disabled || !isPinComplete(pin)}
            className="moo-button moo-pin-input__submit"
          >
            確認
          </button>
        </div>
        <div className="moo-secret-entry__counter">
          {formatPinCounter(pin.length)}
        </div>
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
          disabled={disabled}
          className="moo-button moo-button--link moo-secret-entry__reset"
        >
          重新設定
        </button>
      )}
    </div>
  );
}
