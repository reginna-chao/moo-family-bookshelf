/** Store-page chip copy shared by the options page and the Dialog's 個人設定 switch, so the two
 *  screens never word the same state differently. */

/** The switch is on, but the host permission was taken back in the browser's settings. */
export const STORE_CHIP_REVOKED_MESSAGE = "授權已被收回，請關閉後再開啟一次";

/** The user declined the permission prompt on the options page. */
export const STORE_CHIP_DENIED_MESSAGE = "沒有授權，購買頁就不會顯示家人的名字";

/** The Dialog could not open the options page for the permission prompt. */
export const STORE_CHIP_OPEN_OPTIONS_FALLBACK =
  "請點瀏覽器工具列上的墨家書櫃圖示，在設定頁開啟";

/** The chip shows the message above whenever the switch is on without the permission. */
export function storeChipVisibleMessage(
  enabledOn: boolean,
  grantedOn: boolean,
  message: string,
): string {
  return enabledOn && !grantedOn ? STORE_CHIP_REVOKED_MESSAGE : message;
}
