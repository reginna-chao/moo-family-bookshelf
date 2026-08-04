/**
 * Localized copy for back-off errors (HTTP 429). The Worker may include an
 * `error.retryAfter` hint (seconds); when it does, the UI shows a live
 * countdown, otherwise it falls back to the static "稍後再試" copy.
 */

/** Error codes that can carry a `retryAfter` back-off hint. */
export type RetryErrorCode = "VERIFICATION_LOCKED" | "RATE_LIMITED";

/** 90 → 「1 分 30 秒」, 45 → 「45 秒」. Fractions and negatives are normalized. */
export function formatRetryDelay(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds} 秒`;
  return `${Math.floor(safeSeconds / 60)} 分 ${safeSeconds % 60} 秒`;
}

const RETRY_COPY: Record<
  RetryErrorCode,
  { staticText: string; countdown: (delay: string) => string }
> = {
  VERIFICATION_LOCKED: {
    staticText: "驗證錯誤次數過多，請稍後再試。",
    countdown: (delay) => `驗證錯誤次數過多，請於 ${delay}後再試。`,
  },
  RATE_LIMITED: {
    staticText: "嘗試次數過多，請稍後再試。",
    countdown: (delay) => `嘗試次數過多，請於 ${delay}後再試。`,
  },
};

/**
 * Build the user-facing message for a back-off error. A positive
 * `remainingSeconds` renders the countdown variant; anything else falls back to
 * the static copy (old backends omit `retryAfter`).
 */
export function buildRetryMessage(
  code: RetryErrorCode,
  remainingSeconds: number,
): string {
  const copy = RETRY_COPY[code];
  if (remainingSeconds <= 0) return copy.staticText;
  return copy.countdown(formatRetryDelay(remainingSeconds));
}

/**
 * Countdown-free variant of the same copy. Used as the sentence announced to
 * assistive tech: the visible message re-renders every second, so announcing it
 * verbatim would interrupt a screen-reader user once per second for the whole
 * wait. This one stays stable and is therefore announced only once.
 */
export function buildStaticRetryMessage(code: RetryErrorCode): string {
  return RETRY_COPY[code].staticText;
}
