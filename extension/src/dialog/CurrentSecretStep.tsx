import {
  currentSecretPrompt,
  type CurrentSecretPurpose,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { VerifyMethod } from "../api/types";
import { PatternFrame, PinFrame } from "../secureFrame/frames";

export interface CurrentSecretStepProps {
  /** The account's current method; only `pin` / `pattern` reach this step. */
  method: VerifyMethod;
  purpose: CurrentSecretPurpose;
  onComplete: (secret: string) => void;
  error?: string;
  disabled?: boolean;
  /** Focus the entry on mount: set when it comes back after a refusal (its old frame had focus). */
  autoFocus?: boolean;
}

/** Asks for the account's current PIN / pattern before a verify change, account deletion (#396),
 *  leaving the family or transferring ownership. The entry holds the secret only until it unmounts; the
 *  caller keeps it in state, never storage. */
export function CurrentSecretStep({
  method,
  purpose,
  onComplete,
  error,
  disabled,
  autoFocus,
}: CurrentSecretStepProps) {
  return (
    <div>
      <div className="moo-verify__current">
        {currentSecretPrompt(method, purpose)}
      </div>
      {method === "pattern" ? (
        <PatternFrame
          mode="verify"
          onComplete={onComplete}
          error={error}
          disabled={disabled}
          autoFocus={autoFocus}
        />
      ) : (
        <PinFrame
          mode="verify"
          onComplete={onComplete}
          error={error}
          disabled={disabled}
          autoFocus={autoFocus}
        />
      )}
    </div>
  );
}
