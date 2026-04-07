import { useState, useCallback, useRef, useEffect } from "react";

interface PinInputProps {
  onComplete: (pin: string) => void;
  mode: "setup" | "verify";
  error?: string;
  onCancel?: () => void;
}

const PIN_MIN = 6;
const PIN_MAX = 12;

export function PinInput({ onComplete, mode, error, onCancel }: PinInputProps) {
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
      const value = e.target.value.replace(/\D/g, "");
      if (value.length > PIN_MAX) return;
      setMismatchError("");
      setCurrentPin(value);
    },
    [setCurrentPin],
  );

  const handleConfirm = useCallback(() => {
    if (currentPin.length < PIN_MIN) return;

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
      setMismatchError("兩次輸入的 PIN 碼不一致，請重新輸入。");
      setConfirmPin("");
    }
  }, [currentPin, mode, isConfirming, pin, confirmPin, onComplete]);

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
        : `設定 PIN 碼（${PIN_MIN}-${PIN_MAX} 位數字）`;

  const displayError = mismatchError || error;

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
        placeholder={`${PIN_MIN}-${PIN_MAX} 位數字`}
        aria-label="PIN 輸入"
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-widest focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none mb-2"
      />

      <p className="text-xs text-gray-400 mb-3">
        {currentPin.length}/{PIN_MIN}-{PIN_MAX} 位
      </p>

      {displayError && (
        <p role="alert" className="text-red-500 text-sm mb-3 text-center">
          {displayError}
        </p>
      )}

      <button
        type="button"
        onClick={handleConfirm}
        disabled={currentPin.length < PIN_MIN}
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
