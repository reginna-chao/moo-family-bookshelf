import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import type { ApiClient } from "../api/client";
import { CurrentSecretStep } from "./CurrentSecretStep";
import { useFamilySettingsLeave } from "./useFamilySettingsLeave";

export interface FamilySettingsLeaveBlockProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}

/**
 * 離開家庭 button and its confirm step. Always mounted by `FamilySettings`
 * (never inside a collapsible section), so its state shares the parent's
 * lifetime.
 */
export function FamilySettingsLeaveBlock({
  familyId,
  userId,
  apiClient,
  onLeave,
}: FamilySettingsLeaveBlockProps) {
  const {
    leaveState,
    setLeaveState,
    leaveError,
    setLeaveError,
    requiredMethod,
    secretError,
    startConfirming,
    handleLeaveConfirm,
  } = useFamilySettingsLeave({ familyId, userId, apiClient, onLeave });
  // A PIN / pattern account confirms with its current secret: the entry's own 確認 submits.
  const secretMethod =
    requiredMethod !== null && requiresCurrentSecret(requiredMethod)
      ? requiredMethod
      : null;
  // Either error means the entry is back after a refused secret: its old frame had focus.
  const reasked = secretError !== "" || leaveError !== "";

  return (
    <div className="moo-settings__block">
      {leaveError && (
        <div className="moo-settings__error-text">{leaveError}</div>
      )}
      {leaveState === "idle" && (
        <button
          onClick={() => void startConfirming()}
          className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
        >
          離開家庭
        </button>
      )}
      {leaveState === "confirming" && (
        <div>
          <div className="moo-settings__confirm-prompt">確定要離開嗎？</div>
          {secretMethod !== null && (
            <CurrentSecretStep
              method={secretMethod}
              purpose="leave"
              onComplete={(secret) => void handleLeaveConfirm(secret)}
              error={secretError}
              autoFocus={reasked}
            />
          )}
          <div className="moo-settings__confirm-row">
            {secretMethod === null && (
              <button
                onClick={() => void handleLeaveConfirm()}
                className="moo-button moo-button--danger moo-settings__confirm-yes"
              >
                確定離開
              </button>
            )}
            <button
              onClick={() => {
                setLeaveState("idle");
                setLeaveError("");
              }}
              className="moo-button moo-button--ghost moo-settings__confirm-no"
            >
              取消
            </button>
          </div>
        </div>
      )}
      {leaveState === "leaving" && (
        <button
          disabled
          className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
        >
          離開中...
        </button>
      )}
    </div>
  );
}
