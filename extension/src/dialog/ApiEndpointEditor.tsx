import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ApiClient } from "../api/client";
import { DEFAULT_API_ENDPOINT } from "../constants";

interface ApiEndpointEditorProps {
  apiClient: ApiClient;
  isOwner: boolean;
  familyEndpoint?: string;
  familyId: string;
  onEndpointChanged?: () => void;
}

function isValidEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

export function ApiEndpointEditor({
  apiClient,
  isOwner,
  familyEndpoint,
  familyId,
  onEndpointChanged,
}: ApiEndpointEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const [inputUrl, setInputUrl] = useState("");
  const [currentEndpoint, setCurrentEndpoint] = useState(apiClient.getEndpoint());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (familyEndpoint !== undefined) {
      setCurrentEndpoint(familyEndpoint);
    } else {
      setCurrentEndpoint(apiClient.getEndpoint());
    }
  }, [familyEndpoint, apiClient]);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [pendingAction, setPendingAction] = useState<"save" | "reset" | null>(null);

  const isDefault = currentEndpoint === DEFAULT_API_ENDPOINT;

  const executeSave = async (normalized: string) => {
    setSaving(true);
    setError("");
    const response = await apiClient.updateFamilyEndpoint(familyId, normalized);
    if (response.error) {
      setError(response.error.message);
      setSaving(false);
      return;
    }
    chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: normalized });
    apiClient.setEndpoint(normalized);
    setCurrentEndpoint(normalized);
    setInputUrl("");
    setSaved(true);
    setSaving(false);
    setTimeout(() => setSaved(false), 2000);
    onEndpointChanged?.();
  };

  const executeReset = async () => {
    setSaving(true);
    setError("");
    const response = await apiClient.updateFamilyEndpoint(familyId, null);
    if (response.error) {
      setError(response.error.message);
      setSaving(false);
      return;
    }
    chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: null });
    apiClient.setEndpoint(DEFAULT_API_ENDPOINT);
    setCurrentEndpoint(DEFAULT_API_ENDPOINT);
    setInputUrl("");
    setSaving(false);
    onEndpointChanged?.();
  };

  const handleSave = () => {
    setError("");
    const trimmed = inputUrl.trim();
    if (!trimmed) return;
    if (!isValidEndpoint(trimmed)) {
      setError("請輸入有效的 HTTPS 網址（或 localhost）");
      return;
    }
    setPendingAction("save");
    setShowWarning(true);
  };

  const handleReset = () => {
    setPendingAction("reset");
    setShowWarning(true);
  };

  const handleWarningConfirm = () => {
    setShowWarning(false);
    if (pendingAction === "save") {
      const normalized = inputUrl.trim().replace(/\/+$/, "");
      void executeSave(normalized);
    } else if (pendingAction === "reset") {
      void executeReset();
    }
    setPendingAction(null);
  };

  const handleWarningCancel = () => {
    setShowWarning(false);
    setPendingAction(null);
  };

  const displayEndpoint = familyEndpoint ?? DEFAULT_API_ENDPOINT;
  const displayLabel = familyEndpoint ? "" : "（預設）";

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ color: "#64748b", fontSize: 13, cursor: "pointer", userSelect: "none" }}
      >
        {expanded ? <ChevronDown size={14} style={{ display: "inline", verticalAlign: "middle" }} /> : <ChevronRight size={14} style={{ display: "inline", verticalAlign: "middle" }} />} 進階設定
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {isOwner ? (
            <>
              <div style={{ color: "#64748b", fontSize: 12, marginBottom: 4 }}>目前 API 端點</div>
              <div style={{
                padding: 8, background: "#f8fafc", borderRadius: 6,
                fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", marginBottom: 10,
              }}>
                {currentEndpoint}
              </div>
              <input
                type="url"
                value={inputUrl}
                onChange={(e) => { setInputUrl(e.target.value); setError(""); }}
                placeholder="https://your-worker.example.com"
                style={{
                  width: "100%", padding: 8, border: "1px solid #e2e8f0",
                  borderRadius: 6, fontSize: 13, boxSizing: "border-box", marginBottom: 6,
                }}
              />
              {error && (
                <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 6 }}>{error}</div>
              )}
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button
                  onClick={handleSave}
                  disabled={!inputUrl.trim() || saving}
                  style={{
                    flex: 1, padding: 8, border: "1px solid #2563eb", borderRadius: 6,
                    background: saved ? "#eff6ff" : "transparent", color: "#2563eb",
                    fontWeight: 600, fontSize: 13,
                    cursor: inputUrl.trim() && !saving ? "pointer" : "not-allowed",
                    opacity: inputUrl.trim() && !saving ? 1 : 0.5,
                  }}
                >
                  {saving ? "儲存中..." : saved ? "已儲存" : "儲存"}
                </button>
                <button
                  onClick={handleReset}
                  disabled={isDefault || saving}
                  style={{
                    flex: 1, padding: 8, border: "1px solid #e2e8f0", borderRadius: 6,
                    background: "transparent", color: "#64748b",
                    fontWeight: 600, fontSize: 13,
                    cursor: isDefault || saving ? "not-allowed" : "pointer",
                    opacity: isDefault || saving ? 0.5 : 1,
                  }}
                >
                  重設為預設
                </button>
              </div>
              <div style={{ color: "#f59e0b", fontSize: 12 }}>
                變更 API 端點後，所有家庭成員都必須使用相同的端點
              </div>
              {showWarning && (
                <div style={{
                  position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                  background: "rgba(0,0,0,0.3)", display: "flex",
                  alignItems: "center", justifyContent: "center", zIndex: 9999,
                }}>
                  <div style={{
                    background: "#fff", borderRadius: 12, padding: 20,
                    maxWidth: 360, width: "90%", boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "#334155" }}>
                      ⚠️ 變更 API 端點將導致：
                    </div>
                    <ul style={{ fontSize: 13, color: "#64748b", margin: "0 0 16px 0", paddingLeft: 20, lineHeight: 1.8 }}>
                      <li>所有家庭成員的書籍分享設定需要重新設定</li>
                      <li>家庭需要重新建立，成員需要重新加入</li>
                      <li>舊端點上的資料不會自動遷移</li>
                    </ul>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        onClick={handleWarningCancel}
                        style={{
                          padding: "8px 16px", border: "1px solid #e2e8f0", borderRadius: 6,
                          background: "transparent", color: "#64748b", fontWeight: 600,
                          fontSize: 13, cursor: "pointer",
                        }}
                      >
                        取消
                      </button>
                      <button
                        onClick={handleWarningConfirm}
                        style={{
                          padding: "8px 16px", border: "none", borderRadius: 6,
                          background: "#2563eb", color: "#fff", fontWeight: 600,
                          fontSize: 13, cursor: "pointer",
                        }}
                      >
                        確認變更
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ color: "#64748b", fontSize: 12, marginBottom: 4 }}>
                API 端點（由家庭建立者設定）：
              </div>
              <div style={{
                padding: 8, background: "#f8fafc", borderRadius: 6,
                fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", marginBottom: 8,
              }}>
                {displayEndpoint}{displayLabel && (
                  <span style={{ fontFamily: "sans-serif", color: "#94a3b8", marginLeft: 4 }}>
                    {displayLabel}
                  </span>
                )}
              </div>
              <div style={{ color: "#64748b", fontSize: 12 }}>
                ℹ️ 如需變更，請聯繫家庭建立者
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
