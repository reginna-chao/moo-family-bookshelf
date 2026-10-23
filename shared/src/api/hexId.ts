/** Client-side guard for ids sent in a request path or body; shared so the Extension and PWA reject
 *  the same inputs with the same message. */

/**
 * Throw unless `id` is a 64-character lowercase hex string — the shape of a
 * userId (`deriveUserId`'s SHA-256 hex digest). `label` names the argument in
 * the thrown message: `Invalid <label>: expected 64-char hex string`.
 */
export function assertHexId(id: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new Error(`Invalid ${label}: expected 64-char hex string`);
  }
}
