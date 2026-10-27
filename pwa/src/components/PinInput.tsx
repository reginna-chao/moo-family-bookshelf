import { useState, useCallback, useRef, useEffect } from "react";
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
import { ErrorAlert } from "./ErrorAlert";

interface PinInputProps {
  onComplete: (pin: string) => void;
  mode: "setup" | "verify";
  error?: string;
  /** Stable sentence announced to assistive tech in place of `error` when the
   *  latter ticks (e.g. a back-off countdown). Defaults to `error`. */
  errorAnnouncement?: string;
  onCancel?: () => void;
  /** Block confirmation and PIN entry (e.g. during a back-off countdown or an in-flight submit);
   *  Cancel stays available. Defaults to false. */
  disabled?: boolean;
}

export function PinInput({
  onComplete,
  mode,
  error,
  errorAnnouncement,
  onCancel,
  disabled = false,
}: PinInputProps) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [isConfirming, setIsConfirming] = useState(false);
  const [mismatchError, setMismatchError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const currentPin = isConfirming ? confirmPin : pin;
  const setCurrentPin = isConfirming ? setConfirmPin : setPin;

  // Auto-focus input on mount and step change
  useEffect(() => {
    inputRef.current?.focus();
  }, [isConfirming]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = normalizePinInput(e.target.value);
      if (value === null) return;
      setMismatchError("");
      setCurrentPin(value);
    },
    [setCurrentPin],
  );

  const handleConfirm = useCallback(() => {
    if (disabled || !isPinComplete(currentPin)) return;

    if (mode === "verify") {
      onComplete(currentPin);
      return;
    }

    // Setup mode: first entry
    if (!isConfirming) {
      setIsConfirming(true);
      return;
    }

    // Setup mode: confirm entry
    if (pin === confirmPin) {
      onComplete(pin);
    } else {
      setMismatchError(PIN_MISMATCH_MESSAGE);
      setConfirmPin("");
    }
  }, [disabled, currentPin, mode, isConfirming, pin, confirmPin, onComplete]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      }
    },
    [handleConfirm],
  );

  const title =
    mode === "verify"
      ? "請輸入 PIN 碼"
      : isConfirming
        ? "請再次輸入 PIN 碼確認"
        : `設定 PIN 碼（${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} 位數字）`;

  const displayError = pickSecretEntryError(mismatchError, error);
  // A local mismatch is static copy — it announces itself.
  const displayAnnouncement = mismatchError ? undefined : errorAnnouncement;

  return (
    <div className="flex flex-col items-center w-full max-w-xs mx-auto">
      <h2 className="text-lg font-bold text-gray-900 mb-4">{title}</h2>

      <input
        ref={inputRef}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={currentPin}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={`${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} 位數字`}
        aria-label="PIN 輸入"
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-widest focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none mb-2 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
      />

      <p className="text-xs text-gray-400 mb-3">
        {formatPinCounter(currentPin.length)}
      </p>

      <ErrorAlert
        message={displayError}
        announcement={displayAnnouncement}
        className="mb-3"
      />

      <button
        type="button"
        onClick={handleConfirm}
        disabled={disabled || !isPinComplete(currentPin)}
        className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        確認
      </button>

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          取消
        </button>
      )}
    </div>
  );
}
