/**
 * Does the Readmoo account logged in on the page own the stored userId?
 * (issue #271). The extension's identity lives in chrome.storage, i.e. in the
 * browser profile, so a second Readmoo account in the same profile would
 * otherwise act as the first one.
 *
 * Pure: no navigation, no storage. Callers obtain the email (content/
 * hashNavigation.ts → readMePageProfile, or a scrape already on `#/me`).
 */

import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";

/**
 * - `match`: the page's account derives to the stored userId.
 * - `mismatch`: it derives to a different userId.
 * - `unknown`: no email to compare (not logged in, page changed, too slow).
 */
export type AccountIdentity = "match" | "mismatch" | "unknown";

/**
 * Compare a scraped email against the stored userId. Never compare against the
 * cached USER_EMAIL_KEY instead: any account visiting `#/me` used to overwrite
 * it, so it does not identify the stored user. Rejects only if hashing fails.
 */
export async function compareAccountIdentity(
  email: string | null,
  storedUserId: string,
): Promise<AccountIdentity> {
  if (!email) return "unknown";
  const pageUserId = await deriveUserId(email);
  return pageUserId === storedUserId ? "match" : "mismatch";
}
