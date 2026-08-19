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
 * `RATE_LIMITED` copy for callers holding an error ENVELOPE (`res.error`)
 * instead of a thrown `ApiError`. Returns null for any other code so the caller
 * keeps its own action-specific fallback.
 *
 * The envelope is raw `JSON.parse` output — unlike `ApiError`, whose
 * constructor validates the wait, nothing has checked `retryAfter` yet, and a
 * self-hosted (BYO) backend sending a string / NaN / negative would surface as
 * 「NaN 秒」. Sanitizing here keeps that guard in one place instead of at every
 * call site; an unusable value degrades to the static copy.
 *
 * Deliberately NOT identical to the same-named export in
 * `extension/src/dialog/verificationMessages.ts`: here `retryAfter === 0` counts
 * as unusable and yields the static copy (matching `buildRetryMessage`, whose
 * `<= 0` branch this module has always followed), while the extension renders it
 * as a 「0 秒」 countdown and only rejects negatives. Each side keeps the
 * 0-semantics of the copy helpers it already had, which is also why the pair is
 * not hoisted into `shared/` — one implementation would silently reword one of
 * the two apps. The split is pinned from both ends by
 * `pwa/tests/unit/retryMessage.test.ts` and
 * `extension/tests/unit/dialog/verificationMessages.test.ts`.
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
    retryAfter <= 0
  ) {
    return buildRetryMessage("RATE_LIMITED", 0);
  }
  return buildRetryMessage("RATE_LIMITED", Math.floor(retryAfter));
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
