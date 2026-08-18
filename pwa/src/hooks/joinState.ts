/**
 * State shapes of the landing-page join flow, shared by `LandingPage` and
 * `useQrJoin`. They live beside the hook rather than in the page because the
 * page imports the hook — the dependency only ever points this way.
 */

import type { VerifyMethod } from "@/api/client";

/** Pending auth data waiting for verification completion. */
export interface PendingAuth {
  userId: string;
  familyId: string;
  apiHost?: string;
  verifyMethod: VerifyMethod;
}

/**
 * A QR arrival parked at the custom-host consent gate — everything the join
 * needs, held until the user has seen the address and agreed to it.
 */
export interface PendingHostConsent {
  familyId: string;
  userId: string;
  /** Always set: consent only exists because the sync code carried an `@host`. */
  apiHost: string;
  /** Short-lived QR token; empty string when the QR carried none. */
  qrToken: string;
}

/**
 * Which entry point started the join that is currently in flight; `null` when
 * nothing is running.
 *
 * The origin is a FIELD of the submitting state, never a second flag beside it:
 * every exit that leaves the user on this page (failure, hand-off to the
 * verification prompt) clears both in one assignment, error paths included —
 * only the success exit skips it, because it unmounts the page. A separate
 * `qrJoinBusy` boolean would stay latched after a failed QR join and turn the
 * user's next MANUAL submit into a QR busy screen.
 */
export type JoinOrigin = "form" | "qr";
