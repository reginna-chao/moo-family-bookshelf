import { useState } from "react";
import browser from "webextension-polyfill";
import type { ApiClient } from "../api/client";
import type { ApiErrorPayload, ApiResponse, VerifyMethod } from "../api/types";
import { runGuardedDeparture } from "../storage/selfDeparture";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { readVerifyMethod, recoverStepUp } from "./stepUp";

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
  /** The method read when the confirm opened; null when that read failed. */
  requiredMethod: VerifyMethod | null;
  /** Error shown on the current-PIN / pattern entry. */
  secretError: string;
  /** Read the account's method once, then open the confirm step. */
  startConfirming: () => Promise<void>;
  handleDeleteConfirm: (currentSecret?: string) => Promise<void>;
}

/**
 * Account-deletion confirm flow behind the 移除帳戶 button in FamilySettings.
 * A PIN / pattern account sends its current secret with the delete (#396);
 * the secret is a parameter only, never kept in state or storage.
 */
export function useFamilySettingsDelete({
  userId,
  apiClient,
  onLeave,
}: UseFamilySettingsDeleteOptions): UseFamilySettingsDeleteResult {
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState("");
  const [requiredMethod, setRequiredMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [secretError, setSecretError] = useState("");

  const startConfirming = async () => {
    setDeleteError("");
    setSecretError("");
    setRequiredMethod(await readVerifyMethod(apiClient, userId));
    setDeleteState("confirming");
  };

  const settleDelete = async (response: ApiResponse<{ ok: boolean }>) => {
    if (response.error) return;
    // Best-effort: the server account is already, irreversibly, deleted, so a failed local clear
    // must not block onLeave() or surface as an error.
    try {
      await browser.storage.local.clear();
    } catch (clearErr) {
      console.warn(
        "[FamilySettings] Failed to clear local storage after account deletion",
        clearErr,
      );
    }
    onLeave();
  };

  /** A refused delete; `asked` is the method whose current secret was sent (null: none was). */
  const settleDeleteError = async (
    error: ApiErrorPayload,
    asked: VerifyMethod | null,
  ) => {
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
  };

  const handleDeleteConfirm = async (currentSecret?: string) => {
    setDeleteState("deleting");
    setDeleteError("");
    setSecretError("");
    const asked = currentSecret === undefined ? null : requiredMethod;
    // The refusal is handled after the guard ends: its re-read of the method is no departure.
    const refused: { error?: ApiErrorPayload } = {};
    try {
      // Own departure in flight (#263): the helper blocks silent recovery joins
      // until it settles. Mirrored in the PWA's leave / delete hooks.
      await runGuardedDeparture(
        () => apiClient.deleteAccount(userId, currentSecret),
        (response) => {
          refused.error = response.error;
          return settleDelete(response);
        },
      );
      if (refused.error) await settleDeleteError(refused.error, asked);
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
    requiredMethod,
    secretError,
    startConfirming,
    handleDeleteConfirm,
  };
}
