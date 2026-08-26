/**
 * 繁體中文 copy explaining WHY the dialog dropped back to onboarding after the
 * local family binding was torn down.
 *
 * Both teardown entry points — the silent one in `api/auth-refresh.ts`
 * (`clearFamilyAndNotify`, after a failed recovery join) and the
 * re-verification one in `dialog/useReauth.ts` (`tearDownGoneFamily`) — hand the
 * triggering error code to `onFamilyRemoved`, and `dialog/App.tsx` renders this
 * text as a banner above `Onboarding`. Without it the view just flips with no
 * reason given, which reads as a bug rather than as a state change the user's
 * family owner caused. The PWA already explains the same refusals in
 * `pwa/src/utils/joinErrorMessages.ts`.
 *
 * Copy lives in this module, not inline in the component, so tests can pin the
 * production literals instead of asserting on their own copies of them.
 */

/**
 * Reason text per family-gone error code.
 *
 * A `Map`, NOT an object literal, on purpose — same rationale as
 * `pwa/src/utils/joinErrorMessages.ts` (`JOIN_BLOCKED_MESSAGES`), which spells it
 * out in full: the lookup key is `error.code` straight off the wire and a
 * hostile or buggy self-hosted backend is an explicit threat model here, so an
 * object literal would answer prototype keys (`__proto__`, `constructor`,
 * `toString`) with something that is not a `string | undefined`. A `Map` can
 * only return what was put in.
 *
 * These strings are user-facing and asserted verbatim by the dialog tests;
 * editing one fails them.
 */
export const FAMILY_GONE_NOTICE_MESSAGES: ReadonlyMap<string, string> = new Map(
  [
    [
      "MEMBER_REMOVED",
      "你已被家庭管理者移出家庭。如要繼續使用，可重新建立或加入家庭。",
    ],
    [
      "FAMILY_NOT_FOUND",
      "家庭資料已不存在（可能已解散），已為你解除家庭綁定。",
    ],
    ["FAMILY_FULL", "家庭成員已滿，無法重新連線，已為你解除家庭綁定。"],
  ],
);

/** Shown when the code is not one of the three above — see `familyGoneNoticeText`. */
export const FAMILY_GONE_NOTICE_FALLBACK =
  "家庭連線已失效，已為你解除家庭綁定。";

/**
 * Reason text for a family-gone teardown.
 *
 * In practice only the three `FAMILY_GONE_ERROR_CODES` members can arrive — both
 * callers classify through `isFamilyGoneError` before tearing anything down — so
 * the fallback is defense in depth: an unknown code still gets an explanation
 * rather than a blank banner.
 */
export function familyGoneNoticeText(errorCode: string): string {
  return (
    FAMILY_GONE_NOTICE_MESSAGES.get(errorCode) ?? FAMILY_GONE_NOTICE_FALLBACK
  );
}
