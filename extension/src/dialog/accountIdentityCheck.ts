/**
 * Check that the Readmoo account on the page is the stored user (issue #271):
 * navigate to `#/me`, scrape the email, compare its userId.
 *
 * Two entry points (issue #277):
 * - `checkAccountIdentity` — the Dialog-open check. A `match` is remembered at
 *   MODULE level for the rest of this page load, so re-opening the Dialog on
 *   the same page does not navigate again. The cache serves this ONLY.
 * - `verifyAccountIdentity` — always navigates, never trusts the cache. Every
 *   book sync calls it right before uploading, because another tab sharing the
 *   cookies may have switched accounts since the cached `match`. Onboarding's
 *   first book upload calls it too, right after the scrape (issue #281).
 *
 * After a `#/me` match, Readmoo's login cookie (`content/pageAccountCookie.ts`)
 * may VETO it down to `unknown` — it never confirms the stored user and never
 * yields `mismatch` (docs/architecture.md → 讀墨帳號確認（已加入家庭時）).
 *
 * Nothing is persisted — the next page load checks afresh. The cache is keyed
 * on the userId it confirmed, so it can never vouch for a different stored user.
 *
 * The most recent `verifyAccountIdentity` `mismatch` is remembered too, but
 * ONLY for `cachedIdentity` — onboarding's hand-off to App (issue #284). It is
 * never used to skip a navigation: `checkAccountIdentity` short-circuits on a
 * cached `match` alone.
 */

import {
  compareAccountIdentity,
  type AccountIdentity,
} from "../content/accountIdentity";
import { readMePageProfile } from "../content/hashNavigation";
import { readPageAccountEmail } from "../content/pageAccountCookie";

let confirmedUserId: string | null = null;
// The userId the latest verifyAccountIdentity found to be a DIFFERENT account.
let mismatchedUserId: string | null = null;

/** Record that `userId` belongs to the account on the page (this page load only). */
export function markAccountConfirmed(userId: string): void {
  confirmedUserId = userId;
  mismatchedUserId = null;
}

/**
 * The latest known result for `userId` on this page load, read-only: never
 * navigates. `match` if confirmed, `mismatch` if the latest
 * verifyAccountIdentity found another account (onboarding → App, issue #284),
 * otherwise `unknown`.
 */
export function cachedIdentity(userId: string): AccountIdentity {
  if (confirmedUserId === userId) return "match";
  return mismatchedUserId === userId ? "mismatch" : "unknown";
}

/** Drop the page-load results, e.g. once the stored identity is cleared. */
export function forgetAccountConfirmation(): void {
  confirmedUserId = null;
  mismatchedUserId = null;
}

/**
 * Resolve whether `storedUserId` belongs to the logged-in Readmoo account,
 * reusing this page load's cached `match` when there is one (Dialog open).
 * Never rejects; otherwise identical to verifyAccountIdentity.
 */
export async function checkAccountIdentity(
  storedUserId: string,
  signal?: AbortSignal,
): Promise<AccountIdentity> {
  if (confirmedUserId === storedUserId) return "match";
  return verifyAccountIdentity(storedUserId, signal);
}

/** True when the login cookie names a different account; `null` cookie never vetoes. */
async function cookieVetoes(storedUserId: string): Promise<boolean> {
  const cookieEmail = readPageAccountEmail();
  if (cookieEmail === null) return false;
  return (
    (await compareAccountIdentity(cookieEmail, storedUserId)) === "mismatch"
  );
}

/**
 * Re-read `#/me` and compare, ignoring the cache. A `#/me` match the login
 * cookie contradicts becomes `unknown`: the cookie can only veto, never
 * confirm, and never produces `mismatch`. Never rejects: any failure (no
 * email, scrape error, abort) is `unknown`. A `match` refreshes the cache;
 * any other result drops it, so the next Dialog open checks again, and a
 * `mismatch` is remembered for cachedIdentity. The page hash is restored on
 * every path (see readMePageProfile).
 */
export async function verifyAccountIdentity(
  storedUserId: string,
  signal?: AbortSignal,
): Promise<AccountIdentity> {
  let identity: AccountIdentity;
  try {
    const profile = await readMePageProfile(signal);
    identity = await compareAccountIdentity(profile.email, storedUserId);
    // An SPA may keep the old profile on `#/me` while the cookies moved on.
    if (identity === "match" && (await cookieVetoes(storedUserId))) {
      identity = "unknown";
    }
  } catch {
    identity = "unknown";
  }
  if (identity === "match") {
    markAccountConfirmed(storedUserId);
    return identity;
  }
  forgetAccountConfirmation();
  if (identity === "mismatch") mismatchedUserId = storedUserId;
  return identity;
}
