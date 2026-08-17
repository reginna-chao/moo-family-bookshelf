/**
 * Surfaces the `@host` a sync code carries, so joining a self-hosted backend is
 * visible before the user commits to it. Display only — joining is still the
 * user-initiated action it always was.
 *
 * Three outcomes (see `SyncCodeApiHostResult`):
 *   - default / not-yet-valid sync code → renders nothing.
 *   - a `@host` that WOULD be adopted   → shows the canonical endpoint the
 *     client would actually call (`origin + pathname`), so a homograph shows as
 *     `xn--…`, a userinfo URL cannot masquerade, and a plain-HTTP LAN address is
 *     visibly different from its HTTPS namesake.
 *   - a `@host` that would be REJECTED on adoption → shows a warning instead of
 *     the reassuring line, so a spoofed address is never lent legitimacy.
 *
 * Presentational only, like its PWA twin (pwa/src/components/SyncCodeHostNote):
 * the caller decides where the verdict comes from — the typed sync code on the
 * join screens, the endpoint the client has ALREADY adopted on the verification
 * challenge and on the re-auth modal, the screens where no sync code is on
 * display yet the user is about to hand a secret to that server.
 *
 * `variant` follows that same boundary, and ONLY changes the valid branch's
 * lead-in: a sync code is on screen → "此同步碼…" (`join`, the default); none is
 * → drop it (`verify`), because a re-auth happens long after the join and no
 * sync code takes part in it. The invalid branch's warning is deliberately
 * variant-independent — it is about the sync code that carried the bad host, and
 * an adopted endpoint has already passed the same validation, so that branch is
 * effectively unreachable from a `verify` caller anyway.
 */

import type { SyncCodeApiHostResult } from "../crypto/syncCode";

/** Which screen the note sits on. Keep in sync with the PWA twin. */
type SyncCodeHostNoteVariant = "join" | "verify";

export interface SyncCodeHostNoteProps {
  /** Verdict from `parseSyncCodeApiHost` / `classifySyncCodeApiHost`. */
  result: SyncCodeApiHostResult;
  /** 決定 valid 分支的引導語；join 提「此同步碼」，verify 不提（畫面上沒有同步碼）。 */
  variant?: SyncCodeHostNoteVariant;
  /** Extra layout classes (spacing only); palette and size stay fixed. */
  className?: string;
}

const BASE_CLASS = "moo-sync-host-note";

/** Valid-branch lead-in. Must stay byte-identical to the PWA twin's copy. */
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
        className={`${classes} moo-sync-host-note--invalid`}
        data-testid="sync-code-host-note-invalid"
      >
        ⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認
      </p>
    );
  }

  return (
    <p className={classes} data-testid="sync-code-host-note">
      {VALID_LEAD_IN[variant]}
      <span className="moo-sync-host-note__host">{result.endpoint}</span>
    </p>
  );
}
