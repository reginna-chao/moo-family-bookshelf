import { useState } from "react";
import {
  UNKICK_HINT_TEXT,
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
} from "moo-family-bookshelf-shared/unkick/messages";
import type { ApiClient } from "../api/client";

/**
 * 移除成員後的「解除重新加入限制」入口。
 *
 * 產品語意（文案本身住在 shared/，兩端逐字共用）：解除的是後端的 kicked
 * tombstone，**不會**把對方加回家庭——對方仍須自己輸入同步碼。
 */

// Re-exported so existing import sites (including tests) keep pointing here.
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
        setError(response.error.message);
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
