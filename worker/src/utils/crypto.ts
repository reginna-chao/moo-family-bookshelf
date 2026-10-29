function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
  return toHex(buf);
}

/**
 * Verify record v2 hash: hex HMAC-SHA256 keyed with the server-side pepper
 * (UTF-8), over UTF-8(salt + secret). Same CPU cost as {@link hashSecret}; a
 * leaked record alone no longer allows an offline guess without the pepper.
 */
export async function hashSecretWithPepper(
  pepper: string,
  salt: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(salt + secret),
  );
  return toHex(buf);
}

/**
 * Identify a pepper without storing it: the first 16 hex chars (64 bits) of
 * SHA-256(`"pepper-id:" + pepper`). Stored as `VerifyRecord.pepperId`, so a
 * Worker running with a different pepper can refuse instead of mis-comparing.
 */
export async function pepperFingerprint(pepper: string): Promise<string> {
  const data = new TextEncoder().encode("pepper-id:" + pepper);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return toHex(buf).slice(0, 16);
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
