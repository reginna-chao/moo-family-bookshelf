import { useState } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type {
  ApiErrorPayload,
  ApiResponse,
} from "moo-family-bookshelf-shared/api/types";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { runGuardedDeparture } from "@/utils/selfDeparture";
import { readVerifyMethod, recoverStepUp } from "@/hooks/stepUp";

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
  /** The method read when the confirm opened; null when that read failed. */
  requiredMethod: VerifyMethod | null;
  /** Error shown on the current-PIN / pattern entry. */
  secretError: string;
  /** Read the account's method once, then open the confirm step. */
  startConfirming: () => Promise<void>;
  handleDeleteAccount: (currentSecret?: string) => Promise<void>;
}

/**
 * The caller's own "delete account" flow: confirm → delete → force logout.
 * A PIN / pattern account sends its current secret with the delete (#396);
 * the secret is a parameter only, never kept in state or storage.
 */
export function useDeleteAccount({
  userId,
  apiClient,
  onForceLogout,
}: UseDeleteAccountOptions): DeleteAccountFlow {
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [requiredMethod, setRequiredMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [secretError, setSecretError] = useState("");

  async function startConfirming() {
    setDeleteError(null);
    setSecretError("");
    setRequiredMethod(await readVerifyMethod(apiClient, userId));
    setDeleteState("confirming");
  }

  function settleDelete(res: ApiResponse<{ ok: boolean }>) {
    if (res.error) return;
    onForceLogout();
  }

  /** A refused delete; `asked` is the method whose current secret was sent (null: none was). */
  async function settleDeleteError(
    error: ApiErrorPayload,
    asked: VerifyMethod | null,
  ) {
    const next = await recoverStepUp(apiClient, userId, error, asked);
    if (next?.kind === "ask") {
      setRequiredMethod(next.method);
      setSecretError(next.error);
      setDeleteState("confirming");
      return;
    }
    if (next !== null && error.code === "VERIFICATION_REQUIRED") {
      setDeleteError(next.error);
      setDeleteState("confirming");
      return;
    }
    const msg =
      next?.error ??
      (error.code === "OWNER_CANNOT_DELETE"
        ? "管理者必須先轉移管理權才能移除帳戶"
        : safeErrorText(error.message, "移除帳戶失敗，請稍後再試"));
    setDeleteError(msg);
    setDeleteState("idle");
  }

  async function handleDeleteAccount(currentSecret?: string) {
    setDeleteState("deleting");
    setDeleteError(null);
    setSecretError("");
    const asked = currentSecret === undefined ? null : requiredMethod;
    // The refusal is handled after the guard ends: its re-read of the method is no departure.
    const refused: { error?: ApiErrorPayload } = {};
    try {
      // Own departure in flight (#263): the helper blocks silent recovery joins
      // until it settles. Mirrored in the Extension's leave / delete hooks.
      await runGuardedDeparture(
        () => apiClient.deleteAccount(userId, currentSecret),
        (res) => {
          refused.error = res.error;
          settleDelete(res);
        },
      );
      if (refused.error) await settleDeleteError(refused.error, asked);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "移除帳戶失敗，請稍後再試",
      );
      setDeleteState("idle");
    }
  }

  return {
    deleteState,
    setDeleteState,
    deleteError,
    setDeleteError,
    requiredMethod,
    secretError,
    startConfirming,
    handleDeleteAccount,
  };
}
