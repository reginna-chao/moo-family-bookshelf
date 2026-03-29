import React, { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient, FamilyMember, BoolFlag } from "../api/client";
import { encodeSyncCode } from "../crypto/syncCode";
import { useDisplayName } from "./useDisplayName";
import { DisplayNameEditor } from "./DisplayNameEditor";
import { MemberList } from "./MemberList";
import { DEFAULT_API_ENDPOINT } from "../constants";
import { QrCodeLink } from "./QrCodeLink";
import { ApiEndpointEditor } from "./ApiEndpointEditor";

export interface FamilySettingsProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}
type LeaveState = "idle" | "confirming" | "leaving";

export function FamilySettings({ familyId, userId, apiClient, onLeave }: FamilySettingsProps) {
  const [syncCode, setSyncCode] = useState<string | null>(null);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState("");
  const [copied, setCopied] = useState(false);
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState("");
  const [syncArchived, setSyncArchived] = useState<number>(0);
  const [familyEndpoint, setFamilyEndpoint] = useState<string | undefined>(undefined);
  const skipEndpointSync = useRef(false);
  const displayNameState = useDisplayName({ apiClient, familyId, userId });

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

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError("");
    const response = await apiClient.getFamilyMembers(familyId);
    if (response.error) {
      setMembersError(response.error.message);
    } else if (response.data) {
      setMembers(response.data.members);
      setOwnerId(response.data.ownerId);
      setFamilyEndpoint(response.data.apiEndpoint ?? undefined);

      const serverEndpoint = response.data.apiEndpoint;
      if (!skipEndpointSync.current) {
        const currentEndpoint = apiClient.getEndpoint();
        if (serverEndpoint && serverEndpoint !== currentEndpoint) {
          apiClient.setEndpoint(serverEndpoint);
          chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: serverEndpoint });
        } else if (!serverEndpoint && currentEndpoint !== DEFAULT_API_ENDPOINT) {
          apiClient.setEndpoint(DEFAULT_API_ENDPOINT);
          chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: null });
        }
      }
      skipEndpointSync.current = false;
    }
    setMembersLoading(false);
  }, [familyId, apiClient]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  // Cross-component sync: update local member display name without refetching
  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && changes.displayName) {
        const newName = (changes.displayName.newValue as string) ?? "";
        setMembers(prev => prev.map(m =>
          m.userId === userId ? { ...m, displayName: newName } : m
        ));
      }
    };
    try {
      chrome.storage.onChanged.addListener(listener);
    } catch {
      // Extension context may be invalidated after reload
    }
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener);
      } catch {
        // Extension context may be invalidated after reload
      }
    };
  }, [userId]);

  const handleCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(syncCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
        <button
          onClick={handleCopy}
          disabled={!syncCode}
          style={{
            width: "100%", padding: 10, border: "1px solid #2563eb", borderRadius: 8,
            background: copied ? "#eff6ff" : "transparent", color: "#2563eb",
            fontWeight: 600, cursor: syncCode ? "pointer" : "not-allowed",
            opacity: syncCode ? 1 : 0.5, fontSize: 14,
          }}
        >
          {copied ? "已複製" : "複製同步碼"}
        </button>
        <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
          將此代碼分享給家人即可加入書櫃
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
            onMembersChanged={() => void fetchMembers()}
            familyEndpoint={familyEndpoint}
          />
        )}
      </div>
      <ApiEndpointEditor
        apiClient={apiClient}
        isOwner={userId === ownerId}
        familyEndpoint={familyEndpoint}
        familyId={familyId}
        onEndpointChanged={() => {
          skipEndpointSync.current = true;
          void fetchMembers();
        }}
      />
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
    </div>
  );
}
