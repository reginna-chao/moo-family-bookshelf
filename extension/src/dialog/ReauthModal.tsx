// Re-verification modal over the still-mounted main view (Invariant 2); names the adopted server
// first. Setup screens are deliberately out of scope: docs/architecture.md → 重新驗證視窗.

import type { ApiClient } from "../api/client";
import { classifyAdoptedEndpoint } from "./adoptedEndpoint";
import { SyncCodeHostNote } from "./SyncCodeHostNote";
import { VerificationPrompt } from "./VerificationPrompt";
import type { UseVerificationPromptResult } from "./useVerificationPrompt";

export interface ReauthModalProps {
  /** Sole source of the ADOPTED endpoint shown above the challenge. */
  apiClient: ApiClient;
  /** Live prompt state from `useReauth`. */
  reauth: UseVerificationPromptResult;
}

export function ReauthModal({ apiClient, reauth }: ReauthModalProps) {
  // No input field here can compete with the endpoint, adopted long before the token died.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="需要驗證"
      className="moo-modal-overlay"
    >
      <div className="moo-modal">
        <SyncCodeHostNote
          result={classifyAdoptedEndpoint(apiClient)}
          variant="verify"
          className="moo-sync-host-note--reauth"
        />
        <VerificationPrompt
          method={reauth.method}
          methodError={reauth.methodError}
          error={reauth.error}
          locked={reauth.locked}
          submitting={reauth.submitting}
          countdownSeconds={reauth.countdownSeconds}
          onSubmit={(secret) => void reauth.submit(secret)}
          onCancel={reauth.cancel}
        />
      </div>
    </div>
  );
}
