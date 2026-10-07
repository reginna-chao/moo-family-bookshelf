/** Clipboard invite messages from family settings, shared so both apps word them alike: the sync-code one is
 *  for a desktop Extension join, the link one for a mobile PWA join (plus a sync-once-on-desktop reminder). */

/** Invite message for the desktop Extension join flow (sync code pasted manually). */
export function buildSyncCodeInviteMessage(syncCode: string): string {
  return `🎉 邀請你一起用「墨家書櫃」分享藏書！

我們建立了一個家庭書櫃，加入後就能看見彼此在讀墨分享的書。

家庭同步碼：
${syncCode}

📖 加入方式（電腦版瀏覽器）：
1. 安裝 Chrome 擴充功能「墨家書櫃」
2. 開啟並登入讀墨網站 readmoo.com
3. 點開墨家書櫃，選擇「加入家庭」
4. 貼上上方同步碼即可加入

期待和你一起分享好書 📚`;
}

/** Invite message for the mobile PWA join flow (sync code auto-filled from the link). */
export function buildLinkInviteMessage(inviteUrl: string): string {
  return `🎉 邀請你一起用「墨家書櫃」分享藏書！

我們建立了一個家庭書櫃，加入後就能看見彼此在讀墨分享的書。

👉 點開這個連結即可加入（同步碼會自動帶入）：
${inviteUrl}

📌 小提醒：
手機版無法讀取你的讀墨藏書。如果你也想把自己的書分享給家人，
請至少用一次電腦版（安裝 Chrome 擴充功能、登入讀墨網站同步一次），
你的書才會出現在家庭書櫃裡。

期待和你一起分享好書 📚`;
}
