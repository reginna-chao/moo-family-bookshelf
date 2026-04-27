import React, { useState } from "react";
import { ApiClient, BoolFlag, FamilyMember } from "../api/client";

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
  const [readmooNameEdit, setReadmooNameEdit] = useState<{ userId: string; value: string } | null>(null);
  const [readmooNameSaving, setReadmooNameSaving] = useState(false);

  const isOwner = userId === ownerId;

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

  const handleSaveReadmooName = async (target: FamilyMember, value: string) => {
    setReadmooNameSaving(true);
    setActionError("");
    try {
      await apiClient.updateMemberSettings(familyId, target.userId, { readmooName: value.trim() });
      onMembersChanged();
      setReadmooNameEdit(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "更新失敗");
    } finally {
      setReadmooNameSaving(false);
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

  const smallBtnBase: React.CSSProperties = {
    padding: "4px 10px",
    border: "1px solid",
    borderRadius: 6,
    background: "transparent",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 12,
    marginLeft: 4,
  };

  const hasCustomEndpoint = !!familyEndpoint;

  const renderConfirmDialog = () => {
    if (!confirmAction) return null;

    if (confirmAction.type === "remove") {
      return (
        <div style={{ background: "#fef2f2", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>確定要移除此成員？</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={actionLoading}
              onClick={() => void handleRemove(confirmAction.targetId)}
              style={{
                flex: 1, padding: 8, border: "none", borderRadius: 6,
                background: "#ef4444", color: "white", fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer", fontSize: 13,
                opacity: actionLoading ? 0.5 : 1,
              }}
            >
              {actionLoading ? "處理中..." : "確定"}
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActionError(""); setConfirmAction(null); }}
              style={{
                flex: 1, padding: 8, border: "1px solid #e2e8f0", borderRadius: 6,
                background: "transparent", color: "#64748b", fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer", fontSize: 13,
              }}
            >
              取消
            </button>
          </div>
        </div>
      );
    }

    if (confirmAction.type === "transfer" && !hasCustomEndpoint) {
      return (
        <div style={{ background: "#fef2f2", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>
            確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={actionLoading}
              onClick={() => void handleTransfer(confirmAction.targetId)}
              style={{
                flex: 1, padding: 8, border: "none", borderRadius: 6,
                background: "#ef4444", color: "white", fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer", fontSize: 13,
                opacity: actionLoading ? 0.5 : 1,
              }}
            >
              {actionLoading ? "處理中..." : "確定"}
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActionError(""); setConfirmAction(null); }}
              style={{
                flex: 1, padding: 8, border: "1px solid #e2e8f0", borderRadius: 6,
                background: "transparent", color: "#64748b", fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer", fontSize: 13,
              }}
            >
              取消
            </button>
          </div>
        </div>
      );
    }

    if (confirmAction.type === "transfer" && hasCustomEndpoint) {
      return (
        <div style={{ background: "#fffbeb", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 8 }}>
            ⚠️ 目前家庭使用自訂 API 端點
          </div>
          <div style={{
            padding: 6, background: "#f8fafc", borderRadius: 4,
            fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", marginBottom: 8,
          }}>
            {familyEndpoint}
          </div>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8, lineHeight: 1.6 }}>
            轉移擁有者後，只有新擁有者可以變更或清除此設定。
          </div>
          <ul style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0", paddingLeft: 18, lineHeight: 1.8 }}>
            <li>清除：回復為預設端點（家庭資料將需要重建）</li>
            <li>不清除：新擁有者繼承目前的端點設定</li>
          </ul>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button
              disabled={actionLoading}
              onClick={() => { setActionError(""); setConfirmAction(null); }}
              style={{
                padding: "8px 14px", border: "none", borderRadius: 6,
                background: "transparent", color: "#64748b", fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer", fontSize: 13,
              }}
            >
              取消
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActiveTransferAction("keep"); void handleTransfer(confirmAction.targetId); }}
              style={{
                padding: "8px 14px", border: "1px solid #2563eb", borderRadius: 6,
                background: "transparent", color: "#2563eb", fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer", fontSize: 13,
                opacity: actionLoading ? 0.5 : 1,
              }}
            >
              {actionLoading && activeTransferAction === "keep" ? "處理中..." : "不清除，直接轉移"}
            </button>
            <button
              disabled={actionLoading}
              onClick={() => { setActiveTransferAction("clear"); void handleTransfer(confirmAction.targetId, 1); }}
              style={{
                padding: "8px 14px", border: "none", borderRadius: 6,
                background: "#2563eb", color: "#fff", fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer", fontSize: 13,
                opacity: actionLoading ? 0.5 : 1,
              }}
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
      {actionError && (
        <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{actionError}</div>
      )}
      {renderConfirmDialog()}
      <div style={{ background: "#f8fafc", borderRadius: 8, overflow: "hidden" }}>
        {members.map((member) => {
          const showCanLendToggle = isOwner && member.userId !== userId;
          const canLend = canLendValue(member);
          const isUpdating = canLendUpdating === member.userId;
          return (
            <div key={member.userId} style={{
              padding: "10px 12px", fontSize: 14, borderBottom: "1px solid #e2e8f0",
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                  {getMemberLabel(member)}
                  {member.userId === ownerId && (
                    <span style={{ color: "#f59e0b", fontSize: 12, fontWeight: 600, marginLeft: 4 }}>
                      (管理員)
                    </span>
                  )}
                  {member.userId === userId && (
                    <span style={{ color: "#2563eb", fontSize: 12, fontWeight: 600, marginLeft: 4 }}>
                      (你)
                    </span>
                  )}
                </span>
                {isOwner && member.userId !== userId && !confirmAction && (
                  <span>
                    <button
                      onClick={() => setConfirmAction({ type: "transfer", targetId: member.userId })}
                      style={{ ...smallBtnBase, borderColor: "#2563eb", color: "#2563eb" }}
                    >
                      轉移管理權
                    </button>
                    <button
                      onClick={() => setConfirmAction({ type: "remove", targetId: member.userId })}
                      style={{ ...smallBtnBase, borderColor: "#ef4444", color: "#ef4444" }}
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
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 8,
                      fontSize: 13, color: "#334155",
                      cursor: isUpdating ? "not-allowed" : "pointer",
                      background: "transparent", border: "none", padding: 0,
                      opacity: isUpdating ? 0.6 : 1,
                    }}
                  >
                    <span style={{
                      display: "inline-block", width: 32, height: 18, borderRadius: 9,
                      background: canLend ? "#2563eb" : "#cbd5e1",
                      position: "relative", transition: "background 0.2s", flexShrink: 0,
                    }}>
                      <span style={{
                        display: "block", width: 14, height: 14, borderRadius: 7,
                        background: "#fff", position: "absolute", top: 2,
                        left: canLend ? 16 : 2, transition: "left 0.2s",
                      }} />
                    </span>
                    可借出
                  </button>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
                    關閉後，該成員的書籍不會顯示「申請借閱」按鈕（用於非讀墨家庭成員）
                  </div>
                </div>
              )}
              {showCanLendToggle && canLend && (
                <div style={{ marginTop: 6 }}>
                  {readmooNameEdit?.userId === member.userId ? (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="text"
                        value={readmooNameEdit.value}
                        onChange={(e) => setReadmooNameEdit({ userId: member.userId, value: e.target.value })}
                        placeholder="讀墨顯示名稱"
                        maxLength={50}
                        aria-label={`${getMemberLabel(member)} 的讀墨名稱`}
                        style={{
                          flex: 1, padding: "4px 8px", fontSize: 13,
                          border: "1px solid #cbd5e1", borderRadius: 6,
                        }}
                      />
                      <button
                        disabled={readmooNameSaving || readmooNameEdit.value.trim().length === 0}
                        onClick={() => void handleSaveReadmooName(member, readmooNameEdit.value)}
                        style={{ ...smallBtnBase, borderColor: "#2563eb", color: "#2563eb" }}
                      >
                        {readmooNameSaving ? "儲存中..." : "儲存"}
                      </button>
                      <button
                        disabled={readmooNameSaving}
                        onClick={() => setReadmooNameEdit(null)}
                        style={{ ...smallBtnBase, borderColor: "#94a3b8", color: "#64748b" }}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setReadmooNameEdit({
                        userId: member.userId,
                        value: member.readmooName ?? "",
                      })}
                      style={{
                        background: "transparent", border: "none", padding: 0,
                        fontSize: 13, color: "#2563eb", cursor: "pointer",
                      }}
                    >
                      {member.readmooName
                        ? `讀墨名稱：${member.readmooName}（編輯）`
                        : "設定讀墨名稱（自動借書時識別此成員）"}
                    </button>
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
