/**
 * Surfaces the `@host` a pasted sync code carries, so joining a self-hosted
 * backend is visible before the user commits to it. Display only — joining is
 * still the user-initiated action it always was.
 *
 * Three outcomes (see `parseSyncCodeApiHost`):
 *   - default / not-yet-valid sync code → renders nothing.
 *   - a `@host` that WOULD be adopted   → shows the canonical endpoint the
 *     client would actually call (`origin + pathname`), so a homograph shows as
 *     `xn--…`, a userinfo URL cannot masquerade, and a plain-HTTP LAN address is
 *     visibly different from its HTTPS namesake.
 *   - a `@host` that would be REJECTED on adoption → shows a warning instead of
 *     the reassuring line, so a spoofed address is never lent legitimacy.
 */

import { parseSyncCodeApiHost } from "../crypto/syncCode";

export interface SyncCodeHostNoteProps {
  /** Raw sync-code input, exactly as typed/pasted. */
  syncCode: string;
}

export function SyncCodeHostNote({ syncCode }: SyncCodeHostNoteProps) {
  const result = parseSyncCodeApiHost(syncCode);

  if (result.kind === "none") return null;

  if (result.kind === "invalid") {
    return (
      <p
        role="alert"
        className="moo-sync-host-note moo-sync-host-note--invalid"
        data-testid="sync-code-host-note-invalid"
      >
        ⚠️ 此同步碼的伺服器位址無效或不安全，請向分享者確認
      </p>
    );
  }

  return (
    <p className="moo-sync-host-note" data-testid="sync-code-host-note">
      此同步碼將連線至自訂伺服器：
      <span className="moo-sync-host-note__host">{result.endpoint}</span>
    </p>
  );
}
