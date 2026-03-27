import React, { useState } from "react";
import { ApiClient } from "../api/client";
import { DEFAULT_API_ENDPOINT } from "../constants";

interface ApiEndpointEditorProps {
  apiClient: ApiClient;
}

function isValidEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

export function ApiEndpointEditor({ apiClient }: ApiEndpointEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const [inputUrl, setInputUrl] = useState("");
  const [currentEndpoint, setCurrentEndpoint] = useState(apiClient.getEndpoint());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const isDefault = currentEndpoint === DEFAULT_API_ENDPOINT;

  const handleSave = () => {
    setError("");
    const trimmed = inputUrl.trim();
    if (!trimmed) return;
    if (!isValidEndpoint(trimmed)) {
      setError("請輸入有效的 HTTPS 網址（或 localhost）");
      return;
    }
    const normalized = trimmed.replace(/\/+$/, "");
    chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: normalized });
    apiClient.setEndpoint(normalized);
    setCurrentEndpoint(normalized);
    setInputUrl("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    chrome.runtime.sendMessage({ type: "SET_API_ENDPOINT", apiEndpoint: null });
    apiClient.setEndpoint(DEFAULT_API_ENDPOINT);
    setCurrentEndpoint(DEFAULT_API_ENDPOINT);
    setInputUrl("");
    setError("");
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ color: "#64748b", fontSize: 13, cursor: "pointer", userSelect: "none" }}
      >
        {expanded ? "▼" : "▶"} 進階設定
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }}>
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
              disabled={!inputUrl.trim()}
              style={{
                flex: 1, padding: 8, border: "1px solid #2563eb", borderRadius: 6,
                background: saved ? "#eff6ff" : "transparent", color: "#2563eb",
                fontWeight: 600, fontSize: 13,
                cursor: inputUrl.trim() ? "pointer" : "not-allowed",
                opacity: inputUrl.trim() ? 1 : 0.5,
              }}
            >
              {saved ? "已儲存" : "儲存"}
            </button>
            <button
              onClick={handleReset}
              disabled={isDefault}
              style={{
                flex: 1, padding: 8, border: "1px solid #e2e8f0", borderRadius: 6,
                background: "transparent", color: "#64748b",
                fontWeight: 600, fontSize: 13,
                cursor: isDefault ? "not-allowed" : "pointer",
                opacity: isDefault ? 0.5 : 1,
              }}
            >
              重設為預設
            </button>
          </div>
          <div style={{ color: "#f59e0b", fontSize: 12 }}>
            變更 API 端點後，所有家庭成員都必須使用相同的端點
          </div>
        </div>
      )}
    </div>
  );
}
