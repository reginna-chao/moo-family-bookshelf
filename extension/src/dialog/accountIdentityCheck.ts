/**
 * Boot-time check that the Readmoo account on the page is the stored user
 * (issue #271): navigate to `#/me`, scrape the email, compare its userId.
 *
 * A `match` is remembered at MODULE level for the rest of this page load, so
 * re-opening the Dialog on the same page does not navigate again. Nothing is
 * persisted — the next page load checks afresh. The cache is keyed on the
 * userId it confirmed, so it can never vouch for a different stored user.
 */

import {
  compareAccountIdentity,
  type AccountIdentity,
} from "../content/accountIdentity";
import { readMePageProfile } from "../content/hashNavigation";

let confirmedUserId: string | null = null;

/** Record that `userId` belongs to the account on the page (this page load only). */
export function markAccountConfirmed(userId: string): void {
  confirmedUserId = userId;
}

/** Drop the page-load confirmation, e.g. once the stored identity is cleared. */
export function forgetAccountConfirmation(): void {
  confirmedUserId = null;
}

/**
 * Resolve whether `storedUserId` belongs to the logged-in Readmoo account.
 * Never rejects: any failure (no email, scrape error, abort) is `unknown`.
 * The page hash is restored on every path (see readMePageProfile).
 */
export async function checkAccountIdentity(
  storedUserId: string,
  signal?: AbortSignal,
): Promise<AccountIdentity> {
  if (confirmedUserId === storedUserId) return "match";

  let identity: AccountIdentity;
  try {
    const profile = await readMePageProfile(signal);
    identity = await compareAccountIdentity(profile.email, storedUserId);
  } catch {
    return "unknown";
  }
  if (identity === "match") markAccountConfirmed(storedUserId);
  return identity;
}
