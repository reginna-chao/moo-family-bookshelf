/**
 * Hash a secret with a salt using SHA-256.
 * Returns hex-encoded hash string.
 */
export async function hashSecret(
  salt: string,
  secret: string,
): Promise<string> {
  const data = new TextEncoder().encode(salt + secret);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Both strings must be the same length for meaningful comparison.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
