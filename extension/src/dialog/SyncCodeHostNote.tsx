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
 * challenge, which is the one screen where no sync code is on display yet the
 * user is about to hand a secret to that server.
 */

import type { SyncCodeApiHostResult } from "../crypto/syncCode";

export interface SyncCodeHostNoteProps {
  /** Verdict from `parseSyncCodeApiHost` / `classifySyncCodeApiHost`. */
  result: SyncCodeApiHostResult;
  /** Extra layout classes (spacing only); palette and size stay fixed. */
  className?: string;
}

const BASE_CLASS = "moo-sync-host-note";

export function SyncCodeHostNote({
  result,
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
      此同步碼將連線至自訂伺服器：
      <span className="moo-sync-host-note__host">{result.endpoint}</span>
    </p>
  );
}
