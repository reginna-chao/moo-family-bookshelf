import { useState } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiClient } from "@/api/client";

export type DeleteState = "idle" | "confirming" | "deleting";

interface UseDeleteAccountOptions {
  userId: string;
  apiClient: ApiClient;
  onForceLogout: () => void;
}

export interface DeleteAccountFlow {
  deleteState: DeleteState;
  setDeleteState: (state: DeleteState) => void;
  deleteError: string | null;
  setDeleteError: (error: string | null) => void;
  handleDeleteAccount: () => Promise<void>;
}

/** The caller's own "delete account" flow: confirm → delete → force logout. */
export function useDeleteAccount({
  userId,
  apiClient,
  onForceLogout,
}: UseDeleteAccountOptions): DeleteAccountFlow {
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDeleteAccount() {
    setDeleteState("deleting");
    setDeleteError(null);
    try {
      const res = await apiClient.deleteAccount(userId);
      if (res.error) {
        const msg =
          res.error.code === "OWNER_CANNOT_DELETE"
            ? "管理者必須先轉移管理權才能移除帳戶"
            : safeErrorText(res.error.message, "移除帳戶失敗，請稍後再試");
        setDeleteError(msg);
        setDeleteState("idle");
        return;
      }
      onForceLogout();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "移除失敗");
      setDeleteState("idle");
    }
  }

  return {
    deleteState,
    setDeleteState,
    deleteError,
    setDeleteError,
    handleDeleteAccount,
  };
}
