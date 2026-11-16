/** Account-settings copy (#460) shared by the Extension's 個人設定 and the PWA's settings page, so the
 *  two never word the same state differently. */

/** A save the server refused (the screen has already switched back). */
export const ACCOUNT_SETTINGS_SAVE_FAILED = "儲存失敗，請稍後再試";

/** The server predates account settings (404): every change stays in this browser. */
export const ACCOUNT_SETTINGS_LOCAL_ONLY =
  "伺服器尚未支援設定連動，這些設定只存在這個瀏覽器";

/** Appended to the description of a setting that follows the account. */
export const ACCOUNT_SETTINGS_FOLLOWS_ACCOUNT = "這個設定跟著帳號。";

/** Appended to the 同步封存書籍 description on both surfaces. */
export const SYNC_ARCHIVED_SHARED_NOTE =
  "這個設定跟著帳號，擴充功能和手機版共用。";
