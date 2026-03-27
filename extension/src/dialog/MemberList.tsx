import React, { useState } from "react";
import { ApiClient } from "../api/client";

export interface MemberListProps {
  members: string[];
  ownerId: string;
  userId: string;
  familyId: string;
  apiClient: ApiClient;
  savedDisplayName: string;
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
  savedDisplayName,
  onMembersChanged,
}: MemberListProps) {
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");

  const isOwner = userId === ownerId;

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

  const handleTransfer = async (targetId: string) => {
    setActionLoading(true);
    setActionError("");
    try {
      const response = await apiClient.transferOwnership(familyId, userId, targetId);
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

  const confirmMessage =
    confirmAction?.type === "remove"
      ? "確定要移除此成員？"
      : "確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。";

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

  return (
    <div>
      {actionError && (
        <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{actionError}</div>
      )}
      {confirmAction && (
        <div style={{ background: "#fef2f2", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>{confirmMessage}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={actionLoading}
              onClick={() => {
                if (confirmAction.type === "remove") {
                  void handleRemove(confirmAction.targetId);
                } else {
                  void handleTransfer(confirmAction.targetId);
                }
              }}
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
              onClick={() => setConfirmAction(null)}
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
      )}
      <div style={{ background: "#f8fafc", borderRadius: 8, overflow: "hidden" }}>
        {members.map((memberId) => (
          <div key={memberId} style={{
            padding: "10px 12px", fontSize: 14, borderBottom: "1px solid #e2e8f0",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ fontFamily: "monospace", fontSize: 13 }}>
              {memberId === userId && savedDisplayName
                ? savedDisplayName
                : memberId.slice(0, 8)}
              {memberId === ownerId && (
                <span style={{ color: "#f59e0b", fontSize: 12, fontWeight: 600, marginLeft: 4 }}>
                  (Owner)
                </span>
              )}
              {memberId === userId && (
                <span style={{ color: "#2563eb", fontSize: 12, fontWeight: 600, marginLeft: 4 }}>
                  (你)
                </span>
              )}
            </span>
            {isOwner && memberId !== userId && !confirmAction && (
              <span>
                <button
                  onClick={() => setConfirmAction({ type: "transfer", targetId: memberId })}
                  style={{ ...smallBtnBase, borderColor: "#2563eb", color: "#2563eb" }}
                >
                  轉移管理權
                </button>
                <button
                  onClick={() => setConfirmAction({ type: "remove", targetId: memberId })}
                  style={{ ...smallBtnBase, borderColor: "#ef4444", color: "#ef4444" }}
                >
                  移除
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
