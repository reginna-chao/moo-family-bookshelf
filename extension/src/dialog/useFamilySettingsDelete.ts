import { useState } from "react";
import browser from "webextension-polyfill";
import type { ApiClient } from "../api/client";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";

export type DeleteState = "idle" | "confirming" | "deleting";

export interface UseFamilySettingsDeleteOptions {
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}

export interface UseFamilySettingsDeleteResult {
  deleteState: DeleteState;
  setDeleteState: (state: DeleteState) => void;
  deleteError: string;
  setDeleteError: (error: string) => void;
  handleDeleteConfirm: () => Promise<void>;
}

/** Account-deletion confirm flow behind the 移除帳戶 button in FamilySettings. */
export function useFamilySettingsDelete({
  userId,
  apiClient,
  onLeave,
}: UseFamilySettingsDeleteOptions): UseFamilySettingsDeleteResult {
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState("");

  const handleDeleteConfirm = async () => {
    setDeleteState("deleting");
    setDeleteError("");
    try {
      const response = await apiClient.deleteAccount(userId);
      if (response.error) {
        const msg =
          response.error.code === "OWNER_CANNOT_DELETE"
            ? "管理者必須先轉移管理權才能移除帳戶"
            : safeErrorText(response.error.message, "移除帳戶失敗，請稍後再試");
        setDeleteError(msg);
        setDeleteState("idle");
        return;
      }
      // Best-effort local cleanup: the server account is already deleted and
      // non-reversible, so the server state is the source of truth. A failure
      // to clear local storage must not block onLeave() or surface as an error.
      try {
        await browser.storage.local.clear();
      } catch (clearErr) {
        console.warn(
          "[FamilySettings] Failed to clear local storage after account deletion",
          clearErr,
        );
      }
      onLeave();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "發生未知錯誤");
      setDeleteState("idle");
    }
  };

  return {
    deleteState,
    setDeleteState,
    deleteError,
    setDeleteError,
    handleDeleteConfirm,
  };
}
