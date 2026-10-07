/** Host-note copy (names the self-hosted server before a user hands it anything) — one source for both
 *  apps' `SyncCodeHostNote`, so no two clients describe a server differently. See docs/architecture.md → 共用文案的產品語意. */

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
 * not by omission — see docs/architecture.md → 共用文案的產品語意.
 */
export const SYNC_CODE_HOST_NOTE_INVALID =
  "⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認";
