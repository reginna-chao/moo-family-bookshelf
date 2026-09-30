import type { ApiClient } from "../api/client";
import { useFamilySettingsDelete } from "./useFamilySettingsDelete";

export interface FamilySettingsDeleteBlockProps {
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}

/**
 * 移除帳戶 button and its confirm step. Always mounted by `FamilySettings`
 * (never inside a collapsible section), so its state shares the parent's
 * lifetime.
 */
export function FamilySettingsDeleteBlock({
  userId,
  apiClient,
  onLeave,
}: FamilySettingsDeleteBlockProps) {
  const {
    deleteState,
    setDeleteState,
    deleteError,
    setDeleteError,
    handleDeleteConfirm,
  } = useFamilySettingsDelete({ userId, apiClient, onLeave });

  return (
    <div className="moo-settings__section-divider--spaced">
      {deleteError && (
        <div className="moo-settings__error-text">{deleteError}</div>
      )}
      {deleteState === "idle" && (
        <button
          onClick={() => setDeleteState("confirming")}
          className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
        >
          移除帳戶
        </button>
      )}
      {deleteState === "confirming" && (
        <div>
          <div className="moo-settings__delete-warning">
            <div className="moo-settings__delete-warning-title">
              確定要移除帳戶嗎？
            </div>
            <ul className="moo-settings__delete-warning-list">
              <li>將移除墨家書櫃中的所有資料</li>
              <li>不影響你的讀墨帳號及書籍</li>
              <li>下次登入時將重新設定</li>
            </ul>
          </div>
          <div className="moo-settings__confirm-row">
            <button
              onClick={() => void handleDeleteConfirm()}
              className="moo-button moo-button--danger moo-settings__confirm-yes"
            >
              確定移除
            </button>
            <button
              onClick={() => {
                setDeleteState("idle");
                setDeleteError("");
              }}
              className="moo-button moo-button--ghost moo-settings__confirm-no"
            >
              取消
            </button>
          </div>
        </div>
      )}
      {deleteState === "deleting" && (
        <button
          disabled
          className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
        >
          移除中...
        </button>
      )}
    </div>
  );
}
