/**
 * 繁體中文 copy for the public-shelf dialog's failure paths.
 *
 * The API layer throws `ApiError`, whose `message` is the machine-readable
 * `"CODE: english text"` — never show that to a user. Everything the dialog
 * renders goes through `publicShelfErrorMessage`, so a newly surfaced error
 * (see the delete / update paths that used to swallow theirs) cannot leak raw
 * server English into the UI.
 */

import { ApiError, AUTH_REFRESH_RATE_LIMITED } from "../api/types";
import { rateLimitedMessage } from "./verificationMessages";

/** Codes the public-shelf endpoints return that a user can act on. */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_TITLE: "標題需為 1 至 60 個字",
  INVALID_EXPIRES_DAYS: "過期時間選項無效，請重新選擇",
  MAX_SHELVES_REACHED: "已達公開書櫃數量上限",
  SHELF_NOT_FOUND: "找不到這個公開書櫃，請重新開啟視窗",
  USER_NOT_FOUND: "請先同步個人書櫃，再啟用公開分享",
  UNAUTHORIZED: "登入狀態已失效，請重新開啟書櫃",
  FORBIDDEN: "沒有權限操作這個公開書櫃",
  NETWORK_ERROR: "連線失敗，請檢查網路後再試",
};

/**
 * Map a thrown value to user-facing 繁體中文.
 *
 * 429 reuses the shared back-off copy so the wait (`retryAfter`, whole seconds)
 * reaches the user instead of being dropped; unrecognized failures fall back to
 * the caller's action-specific wording (e.g.「關閉失敗」).
 *
 * The client-synthesized auth-recovery throttle is the one code whose message is
 * already user-facing 繁體中文 — it names an action this module cannot infer
 * (「請重新開啟書櫃」) and carries its own cooldown estimate, so it passes
 * through untouched instead of being flattened into the generic sentence.
 * That passthrough demands `synthesized` as well as the code: the flag is set
 * only by the client's own symbol marker, which no response body can forge, so
 * a BYO backend cannot borrow the code to render arbitrary text in the dialog.
 */
export function publicShelfErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.synthesized && error.code === AUTH_REFRESH_RATE_LIMITED) {
    return error.rawMessage || fallback;
  }
  if (error.code === "RATE_LIMITED") {
    return rateLimitedMessage(error.retryAfter ?? null);
  }
  return CODE_MESSAGES[error.code] ?? fallback;
}

/** Standalone wording for the "your value is not on the server" notice. */
export const UNSAVED_NOTICE = "變更尚未儲存";

/** Appended to an update failure so the divergence is stated, not implied. */
const UNSAVED_SUFFIX = `（${UNSAVED_NOTICE}）`;

/** Failure copy for the title / expiry writes, which leave the UI diverged. */
export function publicShelfSaveErrorMessage(error: unknown): string {
  return `${publicShelfErrorMessage(error, "儲存失敗")}${UNSAVED_SUFFIX}`;
}

/**
 * Client-side rejection of a blank title. Sending it would spend one unit of
 * the per-userId write ceiling just to collect a 400.
 */
export const BLANK_TITLE_MESSAGE = `標題不可留白${UNSAVED_SUFFIX}`;
