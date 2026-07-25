import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { UseDisplayNameResult } from "./useDisplayName";

export interface DisplayNameEditorProps extends UseDisplayNameResult {
  userId: string;
}

export function DisplayNameEditor({
  displayName,
  savedDisplayName,
  nameSaveState,
  nameSaveError,
  setDisplayName,
  handleSaveDisplayName,
  userId,
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

  const saving = nameSaveState === "saving";

  return (
    <div className="moo-name-editor">
      <div className="moo-name-editor__label">顯示名稱</div>
      <div className="moo-name-editor__hint">
        此名稱僅用於家庭書櫃，不影響讀墨帳號
      </div>
      {editing ? (
        <>
          <div className="moo-name-editor__row" aria-busy={saving}>
            <input
              ref={inputRef}
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && !saving) {
                  void handleConfirm();
                } else if (e.key === "Escape" && !saving) {
                  handleCancel();
                }
              }}
              maxLength={20}
              placeholder="輸入顯示名稱"
              disabled={saving}
              className="moo-form-input moo-form-input--block moo-name-editor__input"
            />
            <button
              onClick={() => void handleConfirm()}
              disabled={saving}
              aria-label={saving ? "儲存中" : "確認儲存"}
              className="moo-button moo-button--ghost-icon moo-name-editor__icon-btn"
            >
              {saving ? (
                <div className="moo-name-editor__spinner" />
              ) : (
                <Check size={16} />
              )}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              aria-label="取消編輯"
              className="moo-button moo-button--ghost-icon moo-name-editor__icon-btn moo-name-editor__icon-btn--dim"
            >
              <X size={16} />
            </button>
          </div>
          {nameSaveError && (
            <div className="moo-name-editor__error">{nameSaveError}</div>
          )}
        </>
      ) : (
        <div className="moo-name-editor__row">
          <span className="moo-name-editor__value">
            {savedDisplayName || userId.slice(0, 8)}
          </span>
          <button
            onClick={() => setEditing(true)}
            aria-label="編輯顯示名稱"
            className="moo-button moo-button--ghost-icon moo-name-editor__icon-btn"
          >
            <Pencil size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
