/**
 * Hashing utilities for user identity derivation.
 * Uses Web Crypto API (SHA-256) — no encryption involved.
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
