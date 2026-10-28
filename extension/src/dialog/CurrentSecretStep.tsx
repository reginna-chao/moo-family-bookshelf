import { currentSecretPrompt } from "moo-family-bookshelf-shared/verifyInput/messages";
import type { VerifyMethod } from "../api/types";
import { PatternLock } from "./PatternLock";
import { PinInput } from "./PinInput";

export interface CurrentSecretStepProps {
  /** The account's current method; only `pin` / `pattern` reach this step. */
  method: VerifyMethod;
  purpose: "change" | "delete";
  onComplete: (secret: string) => void;
  error?: string;
  disabled?: boolean;
}

/** Asks for the account's current PIN / pattern before a verify change or account deletion (#396).
 *  The entry holds the secret only until it unmounts; the caller keeps it in state, never storage. */
export function CurrentSecretStep({
  method,
  purpose,
  onComplete,
  error,
  disabled,
}: CurrentSecretStepProps) {
  return (
    <div>
      <div className="moo-verify__current">
        {currentSecretPrompt(method, purpose)}
      </div>
      {method === "pattern" ? (
        <PatternLock
          mode="verify"
          onComplete={onComplete}
          error={error}
          disabled={disabled}
        />
      ) : (
        <PinInput
          mode="verify"
          onComplete={onComplete}
          error={error}
          disabled={disabled}
        />
      )}
    </div>
  );
}
