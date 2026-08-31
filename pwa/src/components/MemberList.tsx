import { useState } from "react";
import { ApiError, BoolFlag } from "@/api/client";
import type { ApiClient, FamilyMember } from "@/api/client";
import { rateLimitedEnvelopeMessage } from "@/utils/retryMessage";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";

function getMemberLabel(member: FamilyMember): string {
  return member.displayName || member.userId.slice(0, 8);
}

function canLendValue(member: FamilyMember): boolean {
  return member.canLend !== BoolFlag.FALSE;
}

/**
 * Failure copy for the member-settings write, which throws instead of
 * returning an envelope. A 429 gets the localized back-off copy (with the wait
 * when the server sent one); everything else keeps the previous wording.
 *
 * Mirrors `memberSettingsErrorMessage` in
 * `extension/src/dialog/memberSettingsMessages.ts` — both clients call the same
 * rate-limited family write endpoints, so the back-off copy must not drift
 * between them. Not a byte-for-byte twin: the extension version additionally
 * passes through the client-synthesized `AUTH_REFRESH_RATE_LIMITED` error, a
 * convention this client does not have (no such code exists in `pwa/src`).
 */
function memberSettingsErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const rateLimited = rateLimitedEnvelopeMessage(err);
    if (rateLimited !== null) return rateLimited;
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * readmooName 對應功能僅在家庭 ≥ 3 人時顯示（家庭 ≤ 2 人時讀墨借出不需要選擇成員）。
 */
const MIN_MEMBERS_FOR_READMOO_NAME = 3;

/** A member the owner just removed, as reported to the parent. */
export interface RemovedMemberInfo {
  userId: string;
  /** Resolved via `getMemberLabel` — never empty. */
  displayName: string;
  /** 每次移除唯一，使父層的 key 能區分「同一人的第二次移除」。 */
  removedAt: number;
}

interface MemberListProps {
  members: FamilyMember[];
  ownerId: string;
  userId: string;
  familyId: string;
  apiClient: ApiClient;
  onMembersChanged: () => void;
  /**
   * Called once a removal succeeds, so the parent can offer to lift the
   * server's 6-hour rejoin block (see `UnkickNotice`). Optional: the removal
   * itself does not depend on it. Reported from here rather than owned here
   * because the notice must outlive a failed member-list refresh, which
   * unmounts this component.
   */
  onMemberRemoved?: (removed: RemovedMemberInfo) => void;
}

type ConfirmAction =
  { type: "remove"; targetId: string } | { type: "transfer"; targetId: string };

export function MemberList({
  members,
  ownerId,
  userId,
  familyId,
  apiClient,
  onMembersChanged,
  onMemberRemoved,
}: MemberListProps) {
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canLendUpdating, setCanLendUpdating] = useState<string | null>(null);

  const isOwner = userId === ownerId;
  const showReadmooNameSection = members.length >= MIN_MEMBERS_FOR_READMOO_NAME;

  async function handleToggleCanLend(target: FamilyMember) {
    setCanLendUpdating(target.userId);
    setError(null);
    const next = canLendValue(target) ? BoolFlag.FALSE : BoolFlag.TRUE;
    try {
      await apiClient.updateMemberSettings(familyId, target.userId, {
        canLend: next,
      });
      onMembersChanged();
    } catch (err) {
      setError(memberSettingsErrorMessage(err, "更新失敗"));
    } finally {
      setCanLendUpdating(null);
    }
  }

  async function handleConfirm() {
    if (!confirmAction) return;
    setLoading(true);
    setError(null);

    try {
      if (confirmAction.type === "remove") {
        const res = await apiClient.removeMember(
          familyId,
          confirmAction.targetId,
        );
        if (res.error) {
          setError(
            rateLimitedEnvelopeMessage(res.error) ??
              safeErrorText(res.error.message, "移除成員失敗，請稍後再試"),
          );
          setLoading(false);
          return;
        }
        // Resolve the label BEFORE the refresh drops the member from the list.
        const removed = members.find(
          (m) => m.userId === confirmAction.targetId,
        );
        onMemberRemoved?.({
          userId: confirmAction.targetId,
          displayName: removed
            ? getMemberLabel(removed)
            : confirmAction.targetId.slice(0, 8),
          removedAt: Date.now(),
        });
      } else {
        const res = await apiClient.transferOwnership(
          familyId,
          userId,
          confirmAction.targetId,
        );
        if (res.error) {
          setError(
            rateLimitedEnvelopeMessage(res.error) ??
              safeErrorText(res.error.message, "轉移管理權失敗，請稍後再試"),
          );
          setLoading(false);
          return;
        }
      }

      setConfirmAction(null);
      onMembersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失敗");
    } finally {
      setLoading(false);
    }
  }

  function handleCancel() {
    setConfirmAction(null);
    setError(null);
  }

  return (
    <div className="bg-gray-50 rounded-lg divide-y divide-gray-200">
      {members.map((member) => {
        const memberId = member.userId;
        const label = getMemberLabel(member);
        const isConfirmTarget =
          confirmAction &&
          ((confirmAction.type === "remove" &&
            confirmAction.targetId === memberId) ||
            (confirmAction.type === "transfer" &&
              confirmAction.targetId === memberId));
        const showCanLendToggle = isOwner && memberId !== userId;
        const canLend = canLendValue(member);
        const isCanLendUpdating = canLendUpdating === memberId;

        return (
          <div key={memberId} className="px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">{label}</span>
              {memberId === ownerId && (
                <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                  管理者
                </span>
              )}
              {memberId === userId && (
                <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                  (你)
                </span>
              )}

              {isOwner && memberId !== userId && !confirmAction && (
                <div className="ml-auto flex gap-1.5">
                  <button
                    onClick={() =>
                      setConfirmAction({ type: "transfer", targetId: memberId })
                    }
                    className="text-xs text-blue-600 hover:text-blue-800 px-1.5 py-0.5"
                  >
                    轉移管理權
                  </button>
                  <button
                    onClick={() =>
                      setConfirmAction({ type: "remove", targetId: memberId })
                    }
                    className="text-xs text-red-600 hover:text-red-800 px-1.5 py-0.5"
                  >
                    移除
                  </button>
                </div>
              )}
            </div>

            {showCanLendToggle && (
              <div className="mt-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={canLend}
                  aria-label={`允許 ${label} 借出書籍`}
                  disabled={isCanLendUpdating}
                  onClick={() => void handleToggleCanLend(member)}
                  className="inline-flex items-center gap-2 text-xs text-gray-700 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span
                    className={`relative inline-block w-8 h-[18px] rounded-full transition-colors ${
                      canLend ? "bg-blue-600" : "bg-gray-300"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 block w-3.5 h-3.5 rounded-full bg-white transition-[left] ${
                        canLend ? "left-[16px]" : "left-0.5"
                      }`}
                    />
                  </span>
                  可借出
                </button>
                <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                  關閉後，該成員的書籍不會顯示「申請借閱」按鈕（用於非讀墨家庭成員）
                </p>
              </div>
            )}

            {showCanLendToggle && canLend && showReadmooNameSection && (
              <div className="mt-2 text-xs">
                {member.readmooName ? (
                  <span className="text-gray-700">
                    讀墨名稱：{member.readmooName}
                  </span>
                ) : (
                  <span className="text-gray-400">
                    尚未記錄（首次借出時自動建立）
                  </span>
                )}
              </div>
            )}

            {isConfirmTarget && (
              <div
                className={`mt-2 rounded p-2 ${confirmAction.type === "remove" ? "bg-red-50" : "bg-blue-50"}`}
              >
                <p
                  className={`text-xs mb-2 ${confirmAction.type === "remove" ? "text-red-700" : "text-blue-700"}`}
                >
                  {confirmAction.type === "remove"
                    ? `確定要移除成員 ${label}？`
                    : `確定要將管理權轉移給 ${label}？轉移後你將無法移除其他成員。`}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleConfirm}
                    disabled={loading}
                    className={`text-xs text-white px-3 py-1 rounded disabled:opacity-50 ${confirmAction.type === "remove" ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"}`}
                  >
                    {loading ? "處理中..." : "確定"}
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={loading}
                    className="text-xs bg-gray-200 text-gray-700 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
