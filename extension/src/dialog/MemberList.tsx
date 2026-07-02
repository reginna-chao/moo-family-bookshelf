import { useState } from "react";
import { ApiClient, BoolFlag, FamilyMember } from "../api/client";

function switchTrackClass(on: boolean): string {
  return on ? "moo-switch__track moo-switch__track--on" : "moo-switch__track";
}

function switchKnobClass(on: boolean): string {
  return on ? "moo-switch__knob moo-switch__knob--on" : "moo-switch__knob";
}

export interface MemberListProps {
  members: FamilyMember[];
  ownerId: string;
  userId: string;
  familyId: string;
  apiClient: ApiClient;
  onMembersChanged: () => void;
  familyEndpoint?: string;
}

function canLendValue(member: FamilyMember): boolean {
  return member.canLend !== BoolFlag.FALSE;
}

type ConfirmAction =
  | { type: "remove"; targetId: string }
  | { type: "transfer"; targetId: string };

function getMemberLabel(member: FamilyMember): string {
  return member.displayName || member.userId.slice(0, 8);
}

/**
 * readmooName 對應功能僅在家庭 ≥ 3 人時顯示（家庭 ≤ 2 人時讀墨借出不需要選擇成員）。
 */
const MIN_MEMBERS_FOR_READMOO_NAME = 3;

export function MemberList({
  members,
  ownerId,
  userId,
  familyId,
  apiClient,
  onMembersChanged,
  familyEndpoint,
}: MemberListProps) {
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [activeTransferAction, setActiveTransferAction] = useState<"keep" | "clear" | null>(null);
  const [canLendUpdating, setCanLendUpdating] = useState<string | null>(null);
  const [readmooNameDeleting, setReadmooNameDeleting] = useState<string | null>(null);

  const isOwner = userId === ownerId;
  const showReadmooNameSection = members.length >= MIN_MEMBERS_FOR_READMOO_NAME;

  const handleToggleCanLend = async (target: FamilyMember) => {
    setCanLendUpdating(target.userId);
    setActionError("");
    const next = canLendValue(target) ? BoolFlag.FALSE : BoolFlag.TRUE;
    try {
      await apiClient.updateMemberSettings(familyId, target.userId, { canLend: next });
      onMembersChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "更新失敗");
    } finally {
      setCanLendUpdating(null);
    }
  };

  const handleDeleteReadmooName = async (target: FamilyMember) => {
    setReadmooNameDeleting(target.userId);
    setActionError("");
    try {
      await apiClient.updateMemberSettings(familyId, target.userId, { readmooName: null });
      onMembersChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setReadmooNameDeleting(null);
    }
  };

  const handleRemove = async (targetId: string) => {
    setActionLoading(true);
    setActionError("");
    try {
      const response = await apiClient.removeMember(familyId, targetId);
      if (response.error) {
        setActionError(response.error.message);
      } else {
        onMembersChanged();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "發生未知錯誤");
    }
    setActionLoading(false);
    setConfirmAction(null);
  };

  const handleTransfer = async (targetId: string, clearEndpoint?: 1) => {
    setActionLoading(true);
    setActionError("");
    try {
      const response = await apiClient.transferOwnership(familyId, userId, targetId, clearEndpoint);
      if (response.error) {
        setActionError(response.error.message);
      } else {
        onMembersChanged();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "發生未知錯誤");
    }
    setActionLoading(false);
    setActiveTransferAction(null);
    setConfirmAction(null);
  };

  const hasCustomEndpoint = !!familyEndpoint;

  const renderConfirmDialog = () => {
    if (!confirmAction) return null;

    if (confirmAction.type === "remove") {
      return (
        <div className="moo-member-list__confirm">
          <div className="moo-member-list__confirm-text">確定要移除此成員？</div>
          <div className="moo-member-list__confirm-row">
            <button
              disabled={actionLoading}
              onClick={() => void handleRemove(confirmAction.targetId)}
              className="moo-member-list__confirm-yes"
            >
              {actionLoading ? "處理中..." : "確定"}
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActionError(""); setConfirmAction(null); }}
              className="moo-member-list__confirm-no"
            >
              取消
            </button>
          </div>
        </div>
      );
    }

    if (confirmAction.type === "transfer" && !hasCustomEndpoint) {
      return (
        <div className="moo-member-list__confirm">
          <div className="moo-member-list__confirm-text">
            確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。
          </div>
          <div className="moo-member-list__confirm-row">
            <button
              disabled={actionLoading}
              onClick={() => void handleTransfer(confirmAction.targetId)}
              className="moo-member-list__confirm-yes"
            >
              {actionLoading ? "處理中..." : "確定"}
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActionError(""); setConfirmAction(null); }}
              className="moo-member-list__confirm-no"
            >
              取消
            </button>
          </div>
        </div>
      );
    }

    if (confirmAction.type === "transfer" && hasCustomEndpoint) {
      return (
        <div className="moo-member-list__confirm moo-member-list__confirm--warn">
          <div className="moo-member-list__confirm-warn-title">
            ⚠️ 目前家庭使用自訂 API 端點
          </div>
          <div className="moo-member-list__endpoint">{familyEndpoint}</div>
          <div className="moo-member-list__confirm-warn-body">
            轉移擁有者後，只有新擁有者可以變更或清除此設定。
          </div>
          <ul className="moo-member-list__confirm-warn-list">
            <li>清除：回復為預設端點（家庭資料將需要重建）</li>
            <li>不清除：新擁有者繼承目前的端點設定</li>
          </ul>
          <div className="moo-member-list__confirm-row moo-member-list__confirm-row--end">
            <button
              disabled={actionLoading}
              onClick={() => { setActionError(""); setConfirmAction(null); }}
              className="moo-member-list__endpoint-cancel"
            >
              取消
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActiveTransferAction("keep"); void handleTransfer(confirmAction.targetId); }}
              className="moo-member-list__endpoint-keep"
            >
              {actionLoading && activeTransferAction === "keep" ? "處理中..." : "不清除，直接轉移"}
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActiveTransferAction("clear"); void handleTransfer(confirmAction.targetId, 1); }}
              className="moo-member-list__endpoint-clear"
            >
              {actionLoading && activeTransferAction === "clear" ? "處理中..." : "清除並轉移"}
            </button>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div>
      {actionError && <div className="moo-member-list__error">{actionError}</div>}
      {renderConfirmDialog()}
      <div className="moo-member-list__table">
        {members.map((member) => {
          const showCanLendToggle = isOwner && member.userId !== userId;
          const canLend = canLendValue(member);
          const isUpdating = canLendUpdating === member.userId;
          const isDeletingReadmooName = readmooNameDeleting === member.userId;
          return (
            <div key={member.userId} className="moo-member-list__row">
              <div className="moo-member-list__row-top">
                <span className="moo-member-list__name">
                  {getMemberLabel(member)}
                  {member.userId === ownerId && (
                    <span className="moo-member-list__badge moo-member-list__badge--owner">
                      (管理員)
                    </span>
                  )}
                  {member.userId === userId && (
                    <span className="moo-member-list__badge moo-member-list__badge--self">
                      (你)
                    </span>
                  )}
                </span>
                {isOwner && member.userId !== userId && !confirmAction && (
                  <span>
                    <button
                      onClick={() => setConfirmAction({ type: "transfer", targetId: member.userId })}
                      className="moo-member-list__small-btn moo-member-list__small-btn--primary"
                    >
                      轉移管理權
                    </button>
                    <button
                      onClick={() => setConfirmAction({ type: "remove", targetId: member.userId })}
                      className="moo-member-list__small-btn moo-member-list__small-btn--danger"
                    >
                      移除
                    </button>
                  </span>
                )}
              </div>
              {showCanLendToggle && (
                <div>
                  <button
                    role="switch"
                    aria-checked={canLend}
                    aria-label={`允許 ${getMemberLabel(member)} 借出書籍`}
                    disabled={isUpdating}
                    onClick={() => void handleToggleCanLend(member)}
                    className="moo-switch moo-switch--inline"
                  >
                    <span className={switchTrackClass(canLend)}>
                      <span className={switchKnobClass(canLend)} />
                    </span>
                    可借出
                  </button>
                  <div className="moo-member-list__toggle-hint">
                    關閉後，該成員的書籍不會顯示「申請借閱」按鈕（用於非讀墨家庭成員）
                  </div>
                </div>
              )}
              {showCanLendToggle && canLend && showReadmooNameSection && (
                <div className="moo-member-list__readmoo">
                  {member.readmooName ? (
                    <>
                      <span className="moo-member-list__readmoo-name">
                        讀墨名稱：{member.readmooName}
                      </span>
                      <button
                        disabled={isDeletingReadmooName}
                        onClick={() => void handleDeleteReadmooName(member)}
                        aria-label={`刪除 ${getMemberLabel(member)} 的讀墨名稱`}
                        className="moo-member-list__small-btn moo-member-list__small-btn--danger moo-member-list__small-btn--flush"
                      >
                        {isDeletingReadmooName ? "刪除中..." : "刪除"}
                      </button>
                    </>
                  ) : (
                    <span className="moo-member-list__readmoo-empty">
                      尚未記錄（首次借出時自動建立）
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
