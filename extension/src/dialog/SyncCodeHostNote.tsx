/** Presentational note disclosing a sync code's `@host` before the user commits; Extension twin of the
 *  PWA's, copy from shared/src/hostNote/messages.ts. See docs/architecture.md → 登入頁的加入流程. */

import {
  SYNC_CODE_HOST_NOTE_INVALID,
  SYNC_CODE_HOST_NOTE_LEAD_IN,
  type SyncCodeHostNoteVariant,
} from "moo-family-bookshelf-shared/hostNote/messages";
import type { SyncCodeApiHostResult } from "../crypto/syncCode";

export interface SyncCodeHostNoteProps {
  /** Verdict from `parseSyncCodeApiHost` / `classifySyncCodeApiHost`. */
  result: SyncCodeApiHostResult;
  /** Picks the valid branch's lead-in: `join` names 「此同步碼」; `verify` / `onboarding` do not (no sync code on screen). */
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
