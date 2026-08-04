/**
 * User-facing wait / lock copy for the verification prompt.
 *
 * Shared by `useVerificationPrompt` (which owns the static message state) and
 * `VerificationPrompt` (which renders the live-countdown variant), so both
 * wordings of each message stay in a single place and cannot drift.
 */

/** Remaining wait as 「45 秒」, or 「14 分 59 秒」 once it reaches a minute. */
export function formatWaitDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  if (safeSeconds < 60) return `${safeSeconds} 秒`;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

/**
 * Join-quota exhausted (429 RATE_LIMITED). Pass null when the backend did not
 * send `retryAfter` — the message then stays static ("請稍後再試").
 */
export function rateLimitedMessage(countdownSeconds: number | null): string {
  if (countdownSeconds === null) return "嘗試次數過多，請稍後再試";
  return `嘗試次數過多，請於 ${formatWaitDuration(countdownSeconds)}後再試`;
}

/**
 * Too many wrong PIN/pattern attempts (429 VERIFICATION_LOCKED). Pass null when
 * the backend did not send `retryAfter` (older deployments) — the message then
 * stays static and the prompt remains locked until the user leaves.
 */
export function verificationLockedMessage(
  countdownSeconds: number | null,
): string {
  if (countdownSeconds === null) return "驗證錯誤次數過多，請稍後再試";
  return `驗證錯誤次數過多，請於 ${formatWaitDuration(countdownSeconds)}後再試`;
}
