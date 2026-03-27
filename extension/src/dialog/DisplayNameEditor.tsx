import React from "react";
import { UseDisplayNameResult } from "./useDisplayName";

export type DisplayNameEditorProps = UseDisplayNameResult;

function getSaveLabel(state: UseDisplayNameResult["nameSaveState"]): string {
  if (state === "saving") return "儲存中...";
  if (state === "saved") return "已儲存";
  return "儲存";
}

export function DisplayNameEditor({
  displayName, savedDisplayName, nameSaveState,
  setDisplayName, handleSaveDisplayName,
}: DisplayNameEditorProps) {
  const isUnchanged = displayName === savedDisplayName;
  const isDisabled = isUnchanged || nameSaveState === "saving";

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: "#64748b", fontSize: 13, marginBottom: 4 }}>顯示名稱</div>
      <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 6 }}>
        此名稱僅用於家庭書櫃，不影響讀墨帳號
      </div>
      <input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="輸入顯示名稱"
        style={{
          width: "100%", padding: 10, border: "1px solid #e2e8f0", borderRadius: 8,
          fontSize: 14, boxSizing: "border-box", marginBottom: 8,
        }}
      />
      <button
        onClick={() => void handleSaveDisplayName()}
        disabled={isDisabled}
        style={{
          width: "100%", padding: 10, border: "none", borderRadius: 8,
          background: isUnchanged ? "#e2e8f0" : "#2563eb",
          color: isUnchanged ? "#94a3b8" : "white",
          fontWeight: 600, fontSize: 14,
          cursor: isDisabled ? "not-allowed" : "pointer",
        }}
      >
        {getSaveLabel(nameSaveState)}
      </button>
    </div>
  );
}
