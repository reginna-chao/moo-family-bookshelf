import React, { useState, useEffect, useCallback } from "react";
import { ApiClient, BoolFlag } from "../api/client";
import { encodeSyncCode } from "../crypto/syncCode";
import { useDisplayName } from "./useDisplayName";
import { DisplayNameEditor } from "./DisplayNameEditor";
import { MemberList } from "./MemberList";
import { DEFAULT_API_ENDPOINT, DEFAULT_PWA_URL } from "../constants";
import { QrCodeLink } from "./QrCodeLink";
import { useFamilyData } from "./FamilyDataContext";

export interface FamilySettingsProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}
type LeaveState = "idle" | "confirming" | "leaving";
type DeleteState = "idle" | "confirming" | "deleting";

export function FamilySettings({ familyId, userId, apiClient, onLeave }: FamilySettingsProps) {
  const {
    members,
    ownerId,
    membersState,
    membersError,
    familyEndpoint,
    refreshMembers: fetchMembers,
    refreshBookshelf,
  } = useFamilyData();

  const [syncCode, setSyncCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState("");
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState("");
  const [syncArchived, setSyncArchived] = useState<number>(0);
  const displayNameState = useDisplayName({ apiClient, familyId, userId });

  const membersLoading = membersState === "loading";

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_SYNC_ARCHIVED" }, (response) => {
      if (response?.syncArchived !== undefined) {
        setSyncArchived(response.syncArchived);
      }
    });
  }, []);

  const handleToggleSyncArchived = useCallback(() => {
    const newValue = syncArchived === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
    setSyncArchived(newValue);
    chrome.runtime.sendMessage(
      { type: "SET_SYNC_ARCHIVED", syncArchived: newValue },
      (response) => {
        if (!response?.ok) {
          setSyncArchived(syncArchived);
        }
      },
    );
  }, [syncArchived]);

  useEffect(() => {
    chrome.storage.local.get(["encryptionKey"], (result) => {
      const encryptionKey = result.encryptionKey as string | undefined;
      if (!encryptionKey) return;
      let apiHost: string | undefined;
      if (familyEndpoint) {
        apiHost = familyEndpoint;
      } else {
        const isCustom = apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT;
        apiHost = isCustom ? apiClient.getEndpoint() : undefined;
      }
      const code = encodeSyncCode({ familyId, encryptionKey, apiHost });
      setSyncCode(code);
    });
  }, [familyId, apiClient, familyEndpoint]);

  // Sync API endpoint from family record (when members data refreshes)
  useEffect(() => {
    if (membersState !== "ready") return;
    const currentEndpoint = apiClient.getEndpoint();
    if (familyEndpoint && familyEndpoint !== currentEndpoint) {
      apiClient.setEndpoint(familyEndpoint);
      chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: familyEndpoint });
    } else if (!familyEndpoint && currentEndpoint !== DEFAULT_API_ENDPOINT) {
      apiClient.setEndpoint(DEFAULT_API_ENDPOINT);
      chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: null });
    }
  }, [membersState, familyEndpoint, apiClient]);

  const handleCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(syncCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleInviteCopy = async () => {
    if (!syncCode) return;
    const inviteUrl = `${DEFAULT_PWA_URL}/#family=${encodeURIComponent(syncCode)}`;
    await navigator.clipboard.writeText(inviteUrl);
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  };

  const dangerBtnBase: React.CSSProperties = { width: "100%", padding: 12,
    border: "1px solid #ef4444", borderRadius: 8, background: "transparent",
    color: "#ef4444", fontWeight: 600, fontSize: 14 };

  const handleLeaveConfirm = async () => {
    setLeaveState("leaving");
    setLeaveError("");
    try {
      const response = await apiClient.leaveFamily(familyId, userId);
      if (response.error) {
        const msg = response.error.code === "OWNER_CANNOT_LEAVE"
          ? "管理者必須先轉移管理權才能離開家庭"
          : response.error.message;
        setLeaveError(msg);
        setLeaveState("idle");
        return;
      }
      onLeave();
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "發生未知錯誤");
      setLeaveState("idle");
    }
  };

  const handleDeleteConfirm = async () => {
    setDeleteState("deleting");
    setDeleteError("");
    try {
      const response = await apiClient.deleteAccount(userId);
      if (response.error) {
        const msg = response.error.code === "OWNER_CANNOT_DELETE"
          ? "管理者必須先轉移管理權才能移除帳戶"
          : response.error.message;
        setDeleteError(msg);
        setDeleteState("idle");
        return;
      }
      chrome.storage.local.clear();
      onLeave();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "發生未知錯誤");
      setDeleteState("idle");
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>個人設定</h3>
      <DisplayNameEditor {...displayNameState} userId={userId} />
      <div style={{ marginBottom: 20 }}>
        <button
          role="switch"
          aria-checked={syncArchived === BoolFlag.TRUE}
          aria-label="同步封存書籍"
          onClick={handleToggleSyncArchived}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 14,
            color: "#334155",
            cursor: "pointer",
            background: "transparent",
            border: "none",
            padding: 0,
          }}
        >
          <span style={{
            display: "inline-block",
            width: 32,
            height: 18,
            borderRadius: 9,
            background: syncArchived === BoolFlag.TRUE ? "#2563eb" : "#cbd5e1",
            position: "relative",
            transition: "background 0.2s",
            flexShrink: 0,
          }}>
            <span style={{
              display: "block",
              width: 14,
              height: 14,
              borderRadius: 7,
              background: "#fff",
              position: "absolute",
              top: 2,
              left: syncArchived === BoolFlag.TRUE ? 16 : 2,
              transition: "left 0.2s",
            }} />
          </span>
          同步封存書籍
        </button>
        <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6, marginBottom: 0 }}>
          啟用後，同步時會一併讀取已封存的書籍
        </div>
      </div>
      {syncCode && (
        <QrCodeLink syncCode={syncCode} userId={userId} />
      )}
      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, marginTop: 4 }} />
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>家庭設定</h3>
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: "#64748b", fontSize: 13, marginBottom: 6 }}>家庭同步碼</div>
        <div style={{
          padding: 12, background: "#f8fafc", borderRadius: 8, marginBottom: 8,
          wordBreak: "break-all", fontSize: 13, fontFamily: "monospace",
        }}>
          {syncCode ?? "載入中..."}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <button
            onClick={handleCopy}
            disabled={!syncCode}
            style={{
              flex: 1, padding: 10, border: "1px solid #2563eb", borderRadius: 8,
              background: copied ? "#eff6ff" : "transparent", color: "#2563eb",
              fontWeight: 600, cursor: syncCode ? "pointer" : "not-allowed",
              opacity: syncCode ? 1 : 0.5, fontSize: 14,
            }}
          >
            {copied ? "已複製" : "複製同步碼"}
          </button>
          <button
            onClick={() => void handleInviteCopy()}
            disabled={!syncCode}
            style={{
              flex: 1, padding: 10, border: "1px solid #10b981", borderRadius: 8,
              background: inviteCopied ? "#ecfdf5" : "transparent", color: "#10b981",
              fontWeight: 600, cursor: syncCode ? "pointer" : "not-allowed",
              opacity: syncCode ? 1 : 0.5, fontSize: 14,
            }}
          >
            {inviteCopied ? "已複製邀請連結" : "邀請成員加入家庭"}
          </button>
        </div>
        <div style={{ color: "#94a3b8", fontSize: 12 }}>
          將同步碼或邀請連結分享給家人即可加入書櫃
        </div>
      </div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: "#64748b", fontSize: 13, marginBottom: 8 }}>
          家庭成員{!membersLoading && !membersError ? ` (${members.length})` : ""}
        </div>
        {membersLoading && (
          <div style={{ color: "#94a3b8", fontSize: 14, textAlign: "center", padding: 12 }}>
            載入中...
          </div>
        )}
        {!membersLoading && membersError && (
          <div style={{ textAlign: "center", padding: 12 }}>
            <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{membersError}</div>
            <button
              onClick={() => void fetchMembers()}
              style={{
                padding: "6px 16px", border: "1px solid #2563eb", borderRadius: 6,
                background: "transparent", color: "#2563eb", fontWeight: 600,
                cursor: "pointer", fontSize: 13,
              }}
            >
              重試
            </button>
          </div>
        )}
        {!membersLoading && !membersError && (
          <MemberList
            members={members}
            ownerId={ownerId}
            userId={userId}
            familyId={familyId}
            apiClient={apiClient}
            onMembersChanged={() => { void fetchMembers(); void refreshBookshelf(); }}
            familyEndpoint={familyEndpoint}
          />
        )}
        <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
          基於讀墨家庭帳戶限制，每個家庭最多 2 位成員
        </div>
      </div>
      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16 }}>
        {leaveError && (
          <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{leaveError}</div>
        )}
        {leaveState === "idle" && (
          <button onClick={() => setLeaveState("confirming")} style={{ ...dangerBtnBase, cursor: "pointer" }}>
            離開家庭
          </button>
        )}
        {leaveState === "confirming" && (
          <div>
            <div style={{ color: "#64748b", fontSize: 14, marginBottom: 8, textAlign: "center" }}>
              確定要離開嗎？
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void handleLeaveConfirm()}
                style={{
                  flex: 1, padding: 12, border: "none", borderRadius: 8,
                  background: "#ef4444", color: "white", fontWeight: 600,
                  cursor: "pointer", fontSize: 14,
                }}
              >
                確定離開
              </button>
              <button
                onClick={() => setLeaveState("idle")}
                style={{
                  flex: 1, padding: 12, border: "1px solid #e2e8f0", borderRadius: 8,
                  background: "transparent", color: "#64748b", fontWeight: 600,
                  cursor: "pointer", fontSize: 14,
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {leaveState === "leaving" && (
          <button disabled style={{ ...dangerBtnBase, cursor: "not-allowed", opacity: 0.5 }}>
            離開中...
          </button>
        )}
      </div>
      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, marginTop: 16 }}>
        {deleteError && (
          <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{deleteError}</div>
        )}
        {deleteState === "idle" && (
          <button
            onClick={() => setDeleteState("confirming")}
            style={{ ...dangerBtnBase, cursor: "pointer" }}
          >
            移除帳戶
          </button>
        )}
        {deleteState === "confirming" && (
          <div>
            <div style={{
              background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8,
              padding: 12, marginBottom: 12,
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#b91c1c", marginBottom: 8 }}>
                確定要移除帳戶嗎？
              </div>
              <ul style={{ fontSize: 12, color: "#ef4444", margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                <li>將移除牧家書櫃中的所有資料</li>
                <li>不影響你的讀墨帳號及書籍</li>
                <li>下次登入時將重新設定</li>
              </ul>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void handleDeleteConfirm()}
                style={{
                  flex: 1, padding: 12, border: "none", borderRadius: 8,
                  background: "#ef4444", color: "white", fontWeight: 600,
                  cursor: "pointer", fontSize: 14,
                }}
              >
                確定移除
              </button>
              <button
                onClick={() => { setDeleteState("idle"); setDeleteError(""); }}
                style={{
                  flex: 1, padding: 12, border: "1px solid #e2e8f0", borderRadius: 8,
                  background: "transparent", color: "#64748b", fontWeight: 600,
                  cursor: "pointer", fontSize: 14,
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {deleteState === "deleting" && (
          <button disabled style={{ ...dangerBtnBase, cursor: "not-allowed", opacity: 0.5 }}>
            移除中...
          </button>
        )}
      </div>
    </div>
  );
}
