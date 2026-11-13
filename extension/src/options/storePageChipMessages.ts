/** Store-page chip copy shared by the options page and the Dialog's 個人設定 switch, so the two
 *  screens never word the same state differently. */

/** The switch is on for the account, but this browser has not granted the host permission. Options page. */
export const STORE_CHIP_NOT_GRANTED_OPTIONS =
  "這個瀏覽器還沒授權，按「授權」後才會在購買頁顯示";

/** The same state in the Dialog, which cannot ask for the permission itself. */
export const STORE_CHIP_NOT_GRANTED_DIALOG =
  "這個瀏覽器還沒授權，請到設定頁授權";

/** The user declined the permission prompt on the options page. */
export const STORE_CHIP_DENIED_MESSAGE = "沒有授權，購買頁就不會顯示家人的名字";

/** The Dialog could not open the options page for the permission prompt. */
export const STORE_CHIP_OPEN_OPTIONS_FALLBACK =
  "請點瀏覽器工具列上的墨家書櫃圖示，在設定頁開啟";

/** Which screen the message is for: only the options page can show the permission prompt. */
export type StoreChipSurface = "options" | "dialog";

/** Whenever the switch is on without this browser's permission, the not-granted copy of `surface`. */
export function storeChipVisibleMessage(
  enabledOn: boolean,
  grantedOn: boolean,
  message: string,
  surface: StoreChipSurface,
): string {
  if (!enabledOn || grantedOn) return message;
  return surface === "options"
    ? STORE_CHIP_NOT_GRANTED_OPTIONS
    : STORE_CHIP_NOT_GRANTED_DIALOG;
}
