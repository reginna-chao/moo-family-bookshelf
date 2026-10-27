/** Copy of the PIN / pattern secret-entry widgets, shared so the Extension and the PWA match (#385). */

import { PATTERN_MIN_DOTS, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "./rules";

/** Shown when the PIN typed in the setup confirm step differs from the first one. */
export const PIN_MISMATCH_MESSAGE = "兩次輸入的 PIN 碼不一致，請重新輸入。";

/** Shown when the pattern drawn in the setup confirm step differs from the first one. */
export const PATTERN_MISMATCH_MESSAGE = "兩次圖形不一致，請重新繪製。";

/** Progress counter under the PIN field, e.g. `3/6-12 位`. */
export function formatPinCounter(length: number): string {
  return `${length}/${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} 位`;
}

/** Progress counter under the pattern grid, e.g. `已連接 3 個點（最少 4 個）`. */
export function formatPatternCounter(dotCount: number): string {
  return `已連接 ${dotCount} 個點（最少 ${PATTERN_MIN_DOTS} 個）`;
}
