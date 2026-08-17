/**
 * Re-verification modal: the overlay + card shell around VerificationPrompt,
 * shown when a dead token can only be recovered by re-supplying the PWA-login
 * verification secret (security-ux Invariant 2). Lives on top of the still
 * mounted main view, so the user never loses their place.
 *
 * It also carries the endpoint disclosure every secret-collecting screen owes
 * the user, the same rule the onboarding challenge follows: before a PIN /
 * pattern is typed, name the server it will be sent to. Unlike a sync-code join,
 * the endpoint here is already PROVEN — it only became the client's endpoint by
 * a successful join or by the user accepting it on the confirmation panel — so
 * this answers no attack; it completes the CHALLENGE half of the rule.
 *
 * Scope, written down so a later reader can tell a drawn line from an oversight:
 * the rule covers CHALLENGE screens — those where the user surrenders an
 * EXISTING secret in exchange for access. SETUP screens, where a new secret is
 * created (VerificationSettings, which only ever sets one up, and the PWA's
 * VerifySetupPrompt), are deliberately out of scope: the secret is not being
 * exchanged for anything yet, and the user is already inside the app by then
 * (the Extension tab requires a family; the PWA prompt appears after login).
 * Those two therefore still collect a secret with no endpoint disclosure — a
 * decision, not a gap left unnoticed.
 */

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
  // This screen has no input field for a competing source to come from: the
  // endpoint was adopted long before the token died. See adoptedEndpoint.ts for
  // the rule itself.
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
