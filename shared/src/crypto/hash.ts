/**
 * Hashing utilities for user identity derivation.
 * Uses Web Crypto API (SHA-256) — no encryption involved.
 *
 * This is the single implementation shared by the Extension and the PWA. Its
 * output IS every existing user's userId, so it must never change — including
 * the double normalization (deriveUserId and sha256Hex each lowercase + trim).
 */

/**
 * Derive a userId from email with an app-specific salt.
 * Prevents rainbow table attacks against plain SHA-256 of email.
 */
export async function deriveUserId(email: string): Promise<string> {
  const normalized = email.toLowerCase().trim();
  return sha256Hex(`moo:${normalized}`);
}

/**
 * SHA-256 hash a string and return the hex digest.
 * Used to derive a deterministic, privacy-preserving userId from email.
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input.toLowerCase().trim());
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
