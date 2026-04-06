import { useState, useCallback } from "react";

interface PinInputProps {
  onComplete: (pin: string) => void;
  mode: "setup" | "verify";
  error?: string;
  onCancel?: () => void;
}

const PIN_MIN = 4;
const PIN_MAX = 6;

const NUMPAD_KEYS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["", "0", "back"],
] as const;

export function PinInput({ onComplete, mode, error, onCancel }: PinInputProps) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [isConfirming, setIsConfirming] = useState(false);
  const [mismatchError, setMismatchError] = useState("");

  const currentPin = isConfirming ? confirmPin : pin;
  const setCurrentPin = isConfirming ? setConfirmPin : setPin;

  const handleKey = useCallback(
    (key: string) => {
      setMismatchError("");
      if (key === "back") {
        setCurrentPin((prev) => prev.slice(0, -1));
        return;
      }
      if (currentPin.length >= PIN_MAX) return;
      setCurrentPin((prev) => prev + key);
    },
    [currentPin.length, setCurrentPin],
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

  const title =
    mode === "verify"
      ? "請輸入 PIN 碼"
      : isConfirming
        ? "請再次輸入 PIN 碼確認"
        : "設定 PIN 碼（4-6 位數字）";

  const displayError = mismatchError || error;

  return (
    <div className="flex flex-col items-center w-full max-w-xs mx-auto">
      <h2 className="text-lg font-bold text-gray-900 mb-4">{title}</h2>

      {/* Digit display */}
      <div className="flex gap-2 mb-3" aria-label="PIN 輸入">
        {Array.from({ length: PIN_MAX }, (_, i) => (
          <div
            key={i}
            className={`w-10 h-12 rounded-lg border-2 flex items-center justify-center text-xl font-bold ${
              i < currentPin.length
                ? "border-blue-500 bg-blue-50 text-blue-700"
                : "border-gray-300 bg-white text-transparent"
            }`}
          >
            {i < currentPin.length ? "\u2022" : ""}
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-400 mb-2">
        {currentPin.length}/{PIN_MIN}-{PIN_MAX} 位
      </p>

      {displayError && (
        <p role="alert" className="text-red-500 text-sm mb-3 text-center">
          {displayError}
        </p>
      )}

      {/* Numpad */}
      <div className="grid grid-cols-3 gap-2 w-full mb-4">
        {NUMPAD_KEYS.flat().map((key, i) => {
          if (key === "") return <div key={i} />;
          if (key === "back") {
            return (
              <button
                key={i}
                type="button"
                onClick={() => handleKey("back")}
                className="h-14 rounded-xl bg-gray-100 text-gray-600 text-lg font-medium active:bg-gray-200 transition-colors"
                aria-label="刪除"
              >
                &#9003;
              </button>
            );
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => handleKey(key)}
              className="h-14 rounded-xl bg-gray-100 text-gray-900 text-xl font-medium active:bg-gray-200 transition-colors"
            >
              {key}
            </button>
          );
        })}
      </div>

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
