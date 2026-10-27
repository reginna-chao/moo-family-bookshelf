/** Copy of the PIN / pattern secret-entry widgets, shared so the Extension and the PWA match (#385). */

import type { VerifyMethod } from "../api/verifyTypes";
import { PATTERN_MIN_DOTS, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "./rules";

/** Shown when the PIN typed in the setup confirm step differs from the first one. */
export const PIN_MISMATCH_MESSAGE = "兩次輸入的 PIN 碼不一致，請重新輸入。";

/** Shown when the pattern drawn in the setup confirm step differs from the first one. */
export const PATTERN_MISMATCH_MESSAGE = "兩次圖形不一致，請重新繪製。";

/** Shown when the server rejects the current PIN sent to change verification or delete the account (#396). */
export const CURRENT_PIN_WRONG_MESSAGE = "目前的 PIN 碼不正確，請重新輸入。";

/** Pattern counterpart of `CURRENT_PIN_WRONG_MESSAGE`. */
export const CURRENT_PATTERN_WRONG_MESSAGE = "目前的圖形不正確，請重新繪製。";

/** Shown when the server asks for the current secret but the account no longer reads as PIN / pattern. */
export const CURRENT_SECRET_UNAVAILABLE_MESSAGE =
  "伺服器要求驗證目前的 PIN 碼或圖形，請稍後再試。";

/** Wrong-current-secret copy for the method whose secret was sent. */
export function currentSecretWrongMessage(method: VerifyMethod): string {
  return method === "pattern"
    ? CURRENT_PATTERN_WRONG_MESSAGE
    : CURRENT_PIN_WRONG_MESSAGE;
}

/** Lead line above the current-secret entry: why it is asked, then what to enter. */
export function currentSecretPrompt(
  method: VerifyMethod,
  purpose: "change" | "delete",
): string {
  const reason = purpose === "change" ? "要更改登入驗證" : "移除帳戶前";
  const ask =
    method === "pattern" ? "請先畫出目前的圖形" : "請先輸入目前的 PIN 碼";
  return `${reason}，${ask}。`;
}

/** Progress counter under the PIN field, e.g. `3/6-12 位`. */
export function formatPinCounter(length: number): string {
  return `${length}/${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} 位`;
}

/** Progress counter under the pattern grid, e.g. `已連接 3 個點（最少 4 個）`. */
export function formatPatternCounter(dotCount: number): string {
  return `已連接 ${dotCount} 個點（最少 ${PATTERN_MIN_DOTS} 個）`;
}
