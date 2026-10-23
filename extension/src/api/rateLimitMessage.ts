/** Copy for the client-synthesized `AUTH_REFRESH_RATE_LIMITED` error, split out of `client.ts` to
 *  keep it under its line ceiling. Rationale: docs/architecture.md → 認證更新與冷卻. */

/** User-facing copy for a rate-limited auto-recovery; appends the wait, rounded up to whole minutes,
 *  when the cooldown deadline is known and still ahead. */
export function buildRateLimitMessage(cooldownUntil?: number): string {
  const base = "嘗試次數過多，請稍後再重新開啟書櫃";
  if (cooldownUntil === undefined) return base;
  const remainingMs = cooldownUntil - Date.now();
  if (remainingMs <= 0) return base;
  const minutes = Math.ceil(remainingMs / (60 * 1000));
  return `${base}（約 ${minutes} 分鐘後）`;
}
