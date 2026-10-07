// 繁體中文 copy explaining WHY the dialog dropped back to onboarding after a family teardown.
// See docs/architecture.md → 家庭綁定被解除時的說明.

import { REMOVED_JOIN_TEXT } from "moo-family-bookshelf-shared/unkick/messages";

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
      `${REMOVED_JOIN_TEXT}如要繼續使用，可以建立新家庭或加入其他家庭。`,
    ],
    [
      "FAMILY_NOT_FOUND",
      "家庭資料已不存在（可能已解散），已為你解除家庭綁定。",
    ],
    ["FAMILY_FULL", "家庭成員已滿，無法重新連線，已為你解除家庭綁定。"],
    ["RECOVERY_NOT_MEMBER", "你已經不是這個家庭的成員，已為你解除家庭綁定。"],
  ],
);

/** Shown when the code is not one of those above — see `familyGoneNoticeText`. */
export const FAMILY_GONE_NOTICE_FALLBACK =
  "家庭連線已失效，已為你解除家庭綁定。";

/**
 * Reason text for a family-gone teardown.
 *
 * In practice only `FAMILY_GONE_ERROR_CODES` members can arrive — both
 * callers classify through `isFamilyGoneError` before tearing anything down — so
 * the fallback is defense in depth: an unknown code still gets an explanation
 * rather than a blank banner.
 */
export function familyGoneNoticeText(errorCode: string): string {
  return (
    FAMILY_GONE_NOTICE_MESSAGES.get(errorCode) ?? FAMILY_GONE_NOTICE_FALLBACK
  );
}
