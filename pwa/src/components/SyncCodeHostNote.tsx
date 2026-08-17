/**
 * Surfaces the `@host` a sync code carries, so joining a self-hosted backend is
 * visible before the user commits to it. PWA twin of the Extension's
 * `SyncCodeHostNote` — same copy, same three outcomes, Tailwind instead of the
 * Dialog's `.moo-*` classes.
 *
 * Presentational only: the caller decides where the verdict comes from (the
 * typed sync code on the form, `pendingAuth.apiHost` on the verification
 * screen), which is what lets one component cover both the code-entry path and
 * the invite-link / QR path where the user never typed the host.
 *
 * `variant` follows the same boundary, and ONLY changes the valid branch's
 * lead-in: a sync code is on screen → "此同步碼…" (`join`, the default); none is
 * → drop it (`verify`), which is the case on the verification screen a QR /
 * invite arrival lands on. The invalid branch's warning is deliberately
 * variant-independent — it is about the sync code that carried the bad host.
 */

import type { SyncCodeApiHostResult } from "@/crypto/syncCode";

/** Which screen the note sits on. Keep in sync with the Extension twin. */
type SyncCodeHostNoteVariant = "join" | "verify";

export interface SyncCodeHostNoteProps {
  /** Verdict from `parseSyncCodeApiHost` / `classifySyncCodeApiHost`. */
  result: SyncCodeApiHostResult;
  /** 決定 valid 分支的引導語；join 提「此同步碼」，verify 不提（畫面上沒有同步碼）。 */
  variant?: SyncCodeHostNoteVariant;
  /** Extra layout classes (spacing only); colour and size are fixed. */
  className?: string;
}

const BASE_CLASS =
  "rounded-md border bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 break-all";

/** Valid-branch lead-in. Must stay byte-identical to the Extension twin's copy. */
const VALID_LEAD_IN: Record<SyncCodeHostNoteVariant, string> = {
  join: "此同步碼將連線至自訂伺服器：",
  verify: "將連線至自訂伺服器：",
};

export function SyncCodeHostNote({
  result,
  variant = "join",
  className = "",
}: SyncCodeHostNoteProps) {
  if (result.kind === "none") return null;

  const classes = className ? `${BASE_CLASS} ${className}` : BASE_CLASS;

  if (result.kind === "invalid") {
    return (
      <p
        role="alert"
        data-testid="sync-code-host-note-invalid"
        className={`${classes} border-amber-400 font-semibold`}
      >
        ⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認
      </p>
    );
  }

  return (
    <p
      data-testid="sync-code-host-note"
      className={`${classes} border-amber-200`}
    >
      {VALID_LEAD_IN[variant]}
      <span className="font-mono">{result.endpoint}</span>
    </p>
  );
}
