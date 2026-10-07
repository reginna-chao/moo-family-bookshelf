/** Presentational note disclosing a sync code's `@host` before the user commits; PWA twin of the
 *  Extension's, copy from shared/src/hostNote/messages.ts. See docs/architecture.md → 登入頁的加入流程. */

import {
  SYNC_CODE_HOST_NOTE_INVALID,
  SYNC_CODE_HOST_NOTE_LEAD_IN,
  type SyncCodeHostNoteVariant,
} from "moo-family-bookshelf-shared/hostNote/messages";
import type { SyncCodeApiHostResult } from "@/crypto/syncCode";

export interface SyncCodeHostNoteProps {
  /** Verdict from `parseSyncCodeApiHost` / `classifySyncCodeApiHost`. */
  result: SyncCodeApiHostResult;
  /** Picks the valid branch's lead-in: `join` names 「此同步碼」; `verify` / `onboarding` do not (no sync code on screen). */
  variant?: SyncCodeHostNoteVariant;
  /** Extra layout classes (spacing only); colour and size are fixed. */
  className?: string;
}

const BASE_CLASS =
  "rounded-md border bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 break-all";

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
        {SYNC_CODE_HOST_NOTE_INVALID}
      </p>
    );
  }

  return (
    <p
      data-testid="sync-code-host-note"
      className={`${classes} border-amber-200`}
    >
      {SYNC_CODE_HOST_NOTE_LEAD_IN[variant]}
      <span className="font-mono">{result.endpoint}</span>
    </p>
  );
}
