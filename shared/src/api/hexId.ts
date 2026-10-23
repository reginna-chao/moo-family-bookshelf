/** Client-side guard for ids sent in a request path or body; shared so the Extension and PWA reject
 *  the same inputs with the same message. */

/**
 * True when `value` is a 64-character lowercase hex string — the shape of a
 * userId (`deriveUserId`'s SHA-256 hex digest) and of a Worker-issued auth token.
 */
export function isHexId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Throw unless `id` is a 64-character lowercase hex string — the shape of a
 * userId (`deriveUserId`'s SHA-256 hex digest). `label` names the argument in
 * the thrown message: `Invalid <label>: expected 64-char hex string`.
 */
export function assertHexId(id: string, label: string): void {
  if (!isHexId(id)) {
    throw new Error(`Invalid ${label}: expected 64-char hex string`);
  }
}
