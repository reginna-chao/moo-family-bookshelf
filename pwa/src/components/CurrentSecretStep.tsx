import { currentSecretPrompt } from "moo-family-bookshelf-shared/verifyInput/messages";
import type { VerifyMethod } from "@/api/client";
import { PatternLock } from "@/components/PatternLock";
import { PinInput } from "@/components/PinInput";

interface CurrentSecretStepProps {
  /** The account's current method; only `pin` / `pattern` reach this step. */
  method: VerifyMethod;
  purpose: "change" | "delete";
  onComplete: (secret: string) => void;
  error?: string;
  onCancel?: () => void;
  disabled?: boolean;
}

/** Asks for the account's current PIN / pattern before a verify change or account deletion (#396).
 *  The entry holds the secret only until it unmounts; the caller keeps it in state, never storage. */
export function CurrentSecretStep({
  method,
  purpose,
  onComplete,
  error,
  onCancel,
  disabled,
}: CurrentSecretStepProps) {
  return (
    <div>
      <p className="text-sm text-gray-600 mb-3 text-center">
        {currentSecretPrompt(method, purpose)}
      </p>
      {method === "pattern" ? (
        <PatternLock
          mode="verify"
          onComplete={onComplete}
          error={error}
          onCancel={onCancel}
          disabled={disabled}
        />
      ) : (
        <PinInput
          mode="verify"
          onComplete={onComplete}
          error={error}
          onCancel={onCancel}
          disabled={disabled}
        />
      )}
    </div>
  );
}
