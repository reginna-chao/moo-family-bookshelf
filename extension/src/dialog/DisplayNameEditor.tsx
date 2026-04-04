import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { UseDisplayNameResult } from "./useDisplayName";

export interface DisplayNameEditorProps extends UseDisplayNameResult {
  userId: string;
}

export function DisplayNameEditor({
  displayName, savedDisplayName, nameSaveState, nameSaveError,
  setDisplayName, handleSaveDisplayName, userId,
}: DisplayNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const handleCancel = () => {
    setDisplayName(savedDisplayName);
    setEditing(false);
  };

  const handleConfirm = async () => {
    const success = await handleSaveDisplayName();
    if (success) {
      setEditing(false);
    }
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: "#64748b", fontSize: 13, marginBottom: 4 }}>顯示名稱</div>
      <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 6 }}>
        此名稱僅用於家庭書櫃，不影響讀墨帳號
      </div>
      {editing ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              ref={inputRef}
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && nameSaveState !== "saving") {
                  void handleConfirm();
                } else if (e.key === "Escape" && nameSaveState !== "saving") {
                  handleCancel();
                }
              }}
              maxLength={20}
              placeholder="輸入顯示名稱"
              style={{
                flex: 1, padding: 10, border: "1px solid #e2e8f0", borderRadius: 8,
                fontSize: 14, boxSizing: "border-box",
              }}
            />
            <button
              onClick={() => void handleConfirm()}
              disabled={nameSaveState === "saving"}
              aria-label="確認儲存"
              style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer" }}
            >
              <Check size={16} style={{ color: "#2563eb" }} />
            </button>
            <button
              onClick={handleCancel}
              disabled={nameSaveState === "saving"}
              aria-label="取消編輯"
              style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer" }}
            >
              <X size={16} style={{ color: "#94a3b8" }} />
            </button>
          </div>
          {nameSaveError && (
            <div style={{ color: "#ef4444", fontSize: 12, marginTop: 6 }}>
              {nameSaveError}
            </div>
          )}
        </>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, color: "#334155" }}>
            {savedDisplayName || userId.slice(0, 8)}
          </span>
          <button
            onClick={() => setEditing(true)}
            aria-label="編輯顯示名稱"
            style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer" }}
          >
            <Pencil size={16} style={{ color: "#94a3b8" }} />
          </button>
        </div>
      )}
    </div>
  );
}
