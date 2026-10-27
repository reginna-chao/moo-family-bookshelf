import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import type { ApiClient } from "../api/client";
import { CurrentSecretStep } from "./CurrentSecretStep";
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
    requiredMethod,
    secretError,
    startConfirming,
    handleDeleteConfirm,
  } = useFamilySettingsDelete({ userId, apiClient, onLeave });
  // A PIN / pattern account confirms with its current secret: the entry's own 確認 submits (#396).
  const secretMethod =
    requiredMethod !== null && requiresCurrentSecret(requiredMethod)
      ? requiredMethod
      : null;

  return (
    <div className="moo-settings__section-divider--spaced">
      {deleteError && (
        <div className="moo-settings__error-text">{deleteError}</div>
      )}
      {deleteState === "idle" && (
        <button
          onClick={() => void startConfirming()}
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
          {secretMethod !== null && (
            <CurrentSecretStep
              method={secretMethod}
              purpose="delete"
              onComplete={(secret) => void handleDeleteConfirm(secret)}
              error={secretError}
            />
          )}
          <div className="moo-settings__confirm-row">
            {secretMethod === null && (
              <button
                onClick={() => void handleDeleteConfirm()}
                className="moo-button moo-button--danger moo-settings__confirm-yes"
              >
                確定移除
              </button>
            )}
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
