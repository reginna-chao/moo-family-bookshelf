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
 * challenge, on the re-auth modal, and on the onboarding container's status
 * note, the places where no sync code is on display yet the user is about to
 * hand a secret (or their whole family setup) to that server.
 *
 * `variant` follows that same boundary, and ONLY changes the valid branch's
 * lead-in: a sync code is on screen → "此同步碼…" (`join`, the default); none is
 * → drop it (`verify`), because a re-auth happens long after the join and no
 * sync code takes part in it; nothing has happened yet → state the current
 * server (`onboarding`). The invalid branch's warning is deliberately
 * variant-independent — it is about the sync code that carried the bad host, and
 * an adopted endpoint has already passed the same validation, so that branch is
 * effectively unreachable from a `verify` / `onboarding` caller anyway.
 *
 * Every string here lives in shared/src/hostNote/messages.ts, imported by BOTH
 * twins — that module, not a comment, is what keeps the two byte-identical.
 */

import {
  SYNC_CODE_HOST_NOTE_INVALID,
  SYNC_CODE_HOST_NOTE_LEAD_IN,
  type SyncCodeHostNoteVariant,
} from "moo-family-bookshelf-shared/hostNote/messages";
import type { SyncCodeApiHostResult } from "../crypto/syncCode";

export interface SyncCodeHostNoteProps {
  /** Verdict from `parseSyncCodeApiHost` / `classifySyncCodeApiHost`. */
  result: SyncCodeApiHostResult;
  /** 決定 valid 分支的引導語；join 提「此同步碼」，verify／onboarding 不提（畫面上沒有同步碼）。 */
  variant?: SyncCodeHostNoteVariant;
  /** Extra layout classes (spacing only); palette and size stay fixed. */
  className?: string;
}

const BASE_CLASS = "moo-sync-host-note";

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
        {SYNC_CODE_HOST_NOTE_INVALID}
      </p>
    );
  }

  return (
    <p className={classes} data-testid="sync-code-host-note">
      {SYNC_CODE_HOST_NOTE_LEAD_IN[variant]}
      <span className="moo-sync-host-note__host">{result.endpoint}</span>
    </p>
  );
}
