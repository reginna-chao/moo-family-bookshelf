/** Does the page's Readmoo account own the stored userId (#271)? Pure — no navigation, no storage; the
 *  caller supplies the email. See docs/architecture.md → 讀墨帳號確認（已加入家庭時）. */

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
