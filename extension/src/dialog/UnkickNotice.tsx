import { useState } from "react";
import {
  UNKICK_HINT_TEXT,
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
} from "moo-family-bookshelf-shared/unkick/messages";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiClient } from "../api/client";

// The "lift the rejoin block" entry after a removal: it clears the kicked tombstone and never re-adds
// the member. Copy in shared/: docs/architecture.md → 共用文案的產品語意.

// Re-exported so tests can treat this component as the single import entry
// for its copy, instead of also reaching into shared/.
export {
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
} from "moo-family-bookshelf-shared/unkick/messages";

export interface UnkickNoticeProps {
  familyId: string;
  targetUserId: string;
  /** Already resolved by the caller (display name or id prefix) — never empty. */
  displayName: string;
  apiClient: ApiClient;
  /** Dismiss the notice. Purely local — nothing is undone server-side. */
  onDismiss: () => void;
}

type UnkickState = "idle" | "clearing" | "cleared";

export function UnkickNotice({
  familyId,
  targetUserId,
  displayName,
  apiClient,
  onDismiss,
}: UnkickNoticeProps) {
  const [state, setState] = useState<UnkickState>("idle");
  const [error, setError] = useState("");

  const handleUnkick = async () => {
    setState("clearing");
    setError("");
    try {
      const response = await apiClient.unkickMember(familyId, targetUserId);
      if (response.error) {
        setError(safeErrorText(response.error.message, "解除失敗，請稍後再試"));
        setState("idle");
        return;
      }
      setState("cleared");
    } catch (err) {
      setError(err instanceof Error ? err.message : "發生未知錯誤");
      setState("idle");
    }
  };

  if (state === "cleared") {
    return (
      <div role="status" className="moo-unkick-notice">
        <div className="moo-unkick-notice__text">
          {buildUnkickedNoticeText(displayName)}
        </div>
        <div className="moo-unkick-notice__actions">
          <button
            onClick={onDismiss}
            className="moo-button moo-button--ghost moo-button--xs"
          >
            關閉
          </button>
        </div>
      </div>
    );
  }

  const clearing = state === "clearing";

  return (
    <div role="status" className="moo-unkick-notice">
      <div className="moo-unkick-notice__text">
        {buildRemovedNoticeText(displayName)}
      </div>
      <div className="moo-unkick-notice__hint">{UNKICK_HINT_TEXT}</div>
      {error && (
        <div role="alert" className="moo-unkick-notice__error">
          {error}
        </div>
      )}
      <div className="moo-unkick-notice__actions">
        <button
          disabled={clearing}
          onClick={() => void handleUnkick()}
          className="moo-button moo-button--outline moo-button--xs"
        >
          {clearing ? "解除中..." : "解除移除限制"}
        </button>
        <button
          disabled={clearing}
          onClick={onDismiss}
          className="moo-button moo-button--ghost moo-button--xs"
        >
          關閉
        </button>
      </div>
    </div>
  );
}
