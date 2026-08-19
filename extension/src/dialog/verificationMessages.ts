/**
 * User-facing wait / lock copy for back-off failures (HTTP 429).
 *
 * Not verification-only: consumers now span `useVerificationPrompt` (which owns
 * the static message state), `VerificationPrompt` (which renders the
 * live-countdown variant), `publicShareMessages` and the rate-limited family
 * write paths. Every wording lives here exactly once so the variants cannot
 * drift apart.
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
 * Rate-limited (429 RATE_LIMITED) — from the per-IP sensitive tier or the
 * verify attempt ceiling; the standalone per-userId join quota no longer
 * exists. Pass null when the backend did not send `retryAfter` — the message
 * then stays static ("請稍後再試").
 */
export function rateLimitedMessage(countdownSeconds: number | null): string {
  if (countdownSeconds === null) return "嘗試次數過多，請稍後再試";
  return `嘗試次數過多，請於 ${formatWaitDuration(countdownSeconds)}後再試`;
}

/**
 * Same copy for callers holding an error ENVELOPE (`response.error`) instead of
 * a thrown `ApiError`. Returns null for any other code so the caller keeps its
 * own action-specific fallback.
 *
 * The envelope is raw `JSON.parse` output — unlike `ApiError`, whose
 * constructor validates the wait, nothing has checked `retryAfter` yet, and a
 * self-hosted (BYO) backend sending a string / NaN / negative would surface as
 * 「NaN 秒」. Sanitizing here keeps that guard in one place instead of at every
 * call site. The parameter is structural on purpose: both `ApiErrorPayload` and
 * a thrown `ApiError` satisfy it, so this module needs no API-layer import.
 *
 * Deliberately NOT identical to the same-named export in
 * `pwa/src/utils/retryMessage.ts`: here `retryAfter === 0` is a valid wait and
 * renders the countdown variant (「0 秒」), so only a negative degrades to the
 * static copy; the PWA treats `<= 0` as static. Each side keeps the 0-semantics
 * of the copy helpers it already had, which is also why the pair is not hoisted
 * into `shared/` — one implementation would silently reword one of the two apps.
 * The split is pinned from both ends by
 * `extension/tests/unit/dialog/verificationMessages.test.ts` and
 * `pwa/tests/unit/retryMessage.test.ts`.
 */
export function rateLimitedEnvelopeMessage(error: {
  code: string;
  retryAfter?: number;
}): string | null {
  if (error.code !== "RATE_LIMITED") return null;
  const { retryAfter } = error;
  if (
    typeof retryAfter !== "number" ||
    !Number.isFinite(retryAfter) ||
    retryAfter < 0
  ) {
    return rateLimitedMessage(null);
  }
  return rateLimitedMessage(Math.floor(retryAfter));
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
