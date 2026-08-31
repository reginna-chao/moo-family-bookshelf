/**
 * Copy for the host note — the line that names the self-hosted server before a
 * user hands it a sync code, a verification secret, or their book list.
 *
 * Shared by the Extension (`extension/src/dialog/SyncCodeHostNote.tsx`) and the
 * PWA (`pwa/src/components/SyncCodeHostNote.tsx`): the two components render the
 * same note in two different styling systems, so the strings used to be
 * duplicated with a comment on each side pledging to stay byte-identical to the
 * twin — a promise nothing enforced. One source file makes that drift
 * impossible, which matters here more than for ordinary copy: two clients
 * describing the SAME server differently is exactly the ambiguity a spoofed
 * host benefits from.
 *
 * 產品語意：三個 variant 只差在 valid 分支的引導語，差別完全取決於「畫面上有沒有
 * 那組同步碼」——
 *   - `join`：同步碼就在畫面上 → 直接指名「此同步碼」。
 *   - `verify`：驗證挑戰畫面上沒有同步碼（可能是建立家庭，或加入很久之後的重新
 *     驗證）→ 不提同步碼。
 *   - `onboarding`：還沒有任何動作發生，只是陳述目前採用的伺服器 → 用現在式。
 * 警告文案刻意不分 variant——它講的是「帶著壞位址的那組同步碼」，與畫面無關。
 *
 * Constants only: no side effects, no runtime-specific globals.
 */

/** Valid-branch lead-in, keyed by the screen the note sits on. */
export const SYNC_CODE_HOST_NOTE_LEAD_IN = {
  join: "此同步碼將連線至自訂伺服器：",
  verify: "將連線至自訂伺服器：",
  onboarding: "目前使用自訂伺服器：",
} as const;

/** Which screen the note sits on — the key set of the lead-in map above. */
export type SyncCodeHostNoteVariant = keyof typeof SYNC_CODE_HOST_NOTE_LEAD_IN;

/**
 * Invalid / unsafe `@host` warning, shown instead of the reassuring lead-in so
 * a spoofed address is never lent legitimacy. Variant-independent by decision,
 * not by omission — see the module docblock.
 */
export const SYNC_CODE_HOST_NOTE_INVALID =
  "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認";
