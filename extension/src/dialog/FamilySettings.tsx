import React, { useState, useEffect, useCallback } from "react";
import { ApiClient } from "../api/client";
import { encodeSyncCode } from "../crypto/syncCode";

const DEFAULT_ENDPOINT = "https://moo-family-bookshelf.workers.dev";
export interface FamilySettingsProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}
type LeaveState = "idle" | "confirming" | "leaving";

export function FamilySettings({ familyId, userId, apiClient, onLeave }: FamilySettingsProps) {
  const [syncCode, setSyncCode] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState("");
  const [copied, setCopied] = useState(false);
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState("");

  useEffect(() => {
    chrome.storage.local.get(["encryptionKey"], (result) => {
      const encryptionKey = result.encryptionKey as string | undefined;
      if (!encryptionKey) return;
      const isCustom = apiClient.getEndpoint() !== DEFAULT_ENDPOINT;
      const code = encodeSyncCode({
        familyId,
        encryptionKey,
        apiHost: isCustom ? apiClient.getEndpoint() : undefined,
      });
      setSyncCode(code);
    });
  }, [familyId, apiClient]);

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError("");
    const response = await apiClient.getFamilyMembers(familyId);
    if (response.error) {
      setMembersError(response.error.message);
    } else if (response.data) {
      setMembers(response.data.members);
    }
    setMembersLoading(false);
  }, [familyId, apiClient]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const handleCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(syncCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const dangerBtnBase: React.CSSProperties = {
    width: "100%", padding: 12, border: "1px solid #ef4444", borderRadius: 8,
    background: "transparent", color: "#ef4444", fontWeight: 600, fontSize: 14,
  };

  const handleLeaveConfirm = async () => {
    setLeaveState("leaving");
    setLeaveError("");
    try {
      const response = await apiClient.leaveFamily(familyId, userId);
      if (response.error) {
        setLeaveError(response.error.message);
        setLeaveState("idle");
        return;
      }
      chrome.runtime.sendMessage({ type: "CLEAR_FAMILY_ID" });
      await chrome.storage.local.remove(["userId", "encryptionKey"]);
      onLeave();
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "發生未知錯誤");
      setLeaveState("idle");
    }
  };

  return (
    <div>
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
          <div style={{ background: "#f8fafc", borderRadius: 8, overflow: "hidden" }}>
            {members.map((memberId) => (
              <div key={memberId} style={{
                padding: "10px 12px", fontSize: 14, borderBottom: "1px solid #e2e8f0",
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span style={{ fontFamily: "monospace", fontSize: 13 }}>{memberId.slice(0, 8)}</span>
                {memberId === userId && (
                  <span style={{ color: "#2563eb", fontSize: 12, fontWeight: 600 }}>(你)</span>
                )}
              </div>
            ))}
          </div>
        )}
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
    </div>
  );
}
