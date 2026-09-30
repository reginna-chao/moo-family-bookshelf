import type { ApiClient } from "../api/client";
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
  const { leaveState, setLeaveState, leaveError, handleLeaveConfirm } =
    useFamilySettingsLeave({ familyId, userId, apiClient, onLeave });

  return (
    <div className="moo-settings__block">
      {leaveError && (
        <div className="moo-settings__error-text">{leaveError}</div>
      )}
      {leaveState === "idle" && (
        <button
          onClick={() => setLeaveState("confirming")}
          className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
        >
          離開家庭
        </button>
      )}
      {leaveState === "confirming" && (
        <div>
          <div className="moo-settings__confirm-prompt">確定要離開嗎？</div>
          <div className="moo-settings__confirm-row">
            <button
              onClick={() => void handleLeaveConfirm()}
              className="moo-button moo-button--danger moo-settings__confirm-yes"
            >
              確定離開
            </button>
            <button
              onClick={() => setLeaveState("idle")}
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
