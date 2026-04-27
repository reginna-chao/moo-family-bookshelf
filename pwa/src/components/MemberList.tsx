import { useState } from "react";
import { BoolFlag } from "@/api/client";
import type { ApiClient, FamilyMember } from "@/api/client";

function getMemberLabel(member: FamilyMember): string {
  return member.displayName || member.userId.slice(0, 8);
}

function canLendValue(member: FamilyMember): boolean {
  return member.canLend !== BoolFlag.FALSE;
}

interface MemberListProps {
  members: FamilyMember[];
  ownerId: string;
  userId: string;
  familyId: string;
  apiClient: ApiClient;
  onMembersChanged: () => void;
}

type ConfirmAction =
  | { type: "remove"; targetId: string }
  | { type: "transfer"; targetId: string };

export function MemberList({
  members,
  ownerId,
  userId,
  familyId,
  apiClient,
  onMembersChanged,
}: MemberListProps) {
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canLendUpdating, setCanLendUpdating] = useState<string | null>(null);

  const isOwner = userId === ownerId;

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
      setError(err instanceof Error ? err.message : "更新失敗");
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
          setError(res.error.message);
          setLoading(false);
          return;
        }
      } else {
        const res = await apiClient.transferOwnership(
          familyId,
          userId,
          confirmAction.targetId,
        );
        if (res.error) {
          setError(res.error.message);
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
              <span className="text-sm text-gray-700">
                {label}
              </span>
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

            {isConfirmTarget && (
              <div className={`mt-2 rounded p-2 ${confirmAction.type === "remove" ? "bg-red-50" : "bg-blue-50"}`}>
                <p className={`text-xs mb-2 ${confirmAction.type === "remove" ? "text-red-700" : "text-blue-700"}`}>
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

      {error && <p role="alert" className="px-3 py-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
