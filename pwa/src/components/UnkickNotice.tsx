import { useState } from "react";
import {
  UNKICK_HINT_TEXT,
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
} from "moo-family-bookshelf-shared/unkick/messages";
import type { ApiClient } from "@/api/client";

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

interface UnkickNoticeProps {
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
  const [error, setError] = useState<string | null>(null);

  async function handleUnkick() {
    setState("clearing");
    setError(null);
    try {
      const res = await apiClient.unkickMember(familyId, targetUserId);
      if (res.error) {
        setError(res.error.message);
        setState("idle");
        return;
      }
      setState("cleared");
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失敗");
      setState("idle");
    }
  }

  if (state === "cleared") {
    return (
      <div role="status" className="rounded bg-amber-50 p-2">
        <p className="text-xs text-amber-800 leading-relaxed">
          {buildUnkickedNoticeText(displayName)}
        </p>
        <div className="flex gap-2 mt-2">
          <button
            onClick={onDismiss}
            className="text-xs bg-gray-200 text-gray-700 px-3 py-1 rounded hover:bg-gray-300"
          >
            關閉
          </button>
        </div>
      </div>
    );
  }

  const clearing = state === "clearing";

  return (
    <div role="status" className="rounded bg-amber-50 p-2">
      <p className="text-xs text-amber-800 leading-relaxed">
        {buildRemovedNoticeText(displayName)}
      </p>
      <p className="text-[11px] text-amber-700 mt-1 leading-relaxed">
        {UNKICK_HINT_TEXT}
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-500 mt-1">
          {error}
        </p>
      )}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => void handleUnkick()}
          disabled={clearing}
          className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {clearing ? "解除中..." : "解除移除限制"}
        </button>
        <button
          onClick={onDismiss}
          disabled={clearing}
          className="text-xs bg-gray-200 text-gray-700 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50"
        >
          關閉
        </button>
      </div>
    </div>
  );
}
