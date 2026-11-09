import { useState } from "react";
import type { ApiClient } from "../api/client";
import type { ApiErrorPayload, ApiResponse, VerifyMethod } from "../api/types";
import { runGuardedDeparture } from "../storage/selfDeparture";
import { pinDepartureServer } from "./departureServerPin";
import { readVerifyMethod, recoverStepUp } from "./stepUp";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";

export type LeaveState = "idle" | "confirming" | "leaving";

export interface UseFamilySettingsLeaveOptions {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}

export interface UseFamilySettingsLeaveResult {
  leaveState: LeaveState;
  setLeaveState: (state: LeaveState) => void;
  leaveError: string;
  setLeaveError: (error: string) => void;
  /** The method read when the confirm opened; null when that read failed. */
  requiredMethod: VerifyMethod | null;
  /** Error shown on the current-PIN / pattern entry. */
  secretError: string;
  /** Read the account's method once, then open the confirm step. */
  startConfirming: () => Promise<void>;
  handleLeaveConfirm: (currentSecret?: string) => Promise<void>;
}

/**
 * Leave-family confirm flow behind the 離開家庭 button in FamilySettings.
 * A PIN / pattern account sends its current secret with the leave; the secret
 * is a parameter only, never kept in state or storage.
 */
export function useFamilySettingsLeave({
  familyId,
  userId,
  apiClient,
  onLeave,
}: UseFamilySettingsLeaveOptions): UseFamilySettingsLeaveResult {
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState("");
  const [requiredMethod, setRequiredMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [secretError, setSecretError] = useState("");

  const startConfirming = async () => {
    setLeaveError("");
    setSecretError("");
    setRequiredMethod(await readVerifyMethod(apiClient, userId));
    setLeaveState("confirming");
  };

  /** Ends in onLeave() on success; any other refusal is returned for handling after the guard. */
  const settleLeave = (
    response: ApiResponse<{ ok: boolean }>,
  ): ApiErrorPayload | undefined => {
    // MEMBER_NOT_FOUND / FAMILY_NOT_FOUND on a self-leave mean "already left": treat as success.
    // Why: docs/architecture.md → 移除成員與離開家庭的重試; PWA twin in .claude/rules/frontend.md.
    const code = response.error?.code;
    const alreadyLeft =
      code === "MEMBER_NOT_FOUND" || code === "FAMILY_NOT_FOUND";
    if (response.error && !alreadyLeft) return response.error;
    onLeave();
    return undefined;
  };

  /** A refused leave; `asked` is the method whose current secret was sent (null: none was). */
  const settleLeaveError = async (
    error: ApiErrorPayload,
    asked: VerifyMethod | null,
  ) => {
    const next = await recoverStepUp(apiClient, userId, error, asked);
    if (next?.kind === "ask") {
      setRequiredMethod(next.method);
      setSecretError(next.error);
      setLeaveState("confirming");
      return;
    }
    if (next !== null && error.code === "VERIFICATION_REQUIRED") {
      setLeaveError(next.error);
      setLeaveState("confirming");
      return;
    }
    // 429 copy comes from recoverStepUp's back-off branch, never the server's English message.
    const msg =
      next?.error ??
      (error.code === "OWNER_CANNOT_LEAVE"
        ? "管理者必須先轉移管理權才能離開家庭"
        : safeErrorText(error.message, "離開家庭失敗，請稍後再試"));
    setLeaveError(msg);
    setLeaveState("idle");
  };

  const handleLeaveConfirm = async (currentSecret?: string) => {
    setLeaveState("leaving");
    setLeaveError("");
    setSecretError("");
    const asked = currentSecret === undefined ? null : requiredMethod;
    // The refusal is handled after the guard ends: its re-read of the method is no departure.
    const refused: { error?: ApiErrorPayload } = {};
    try {
      const assertSameServer = pinDepartureServer(apiClient);
      // Own departure in flight (#263): the helper blocks silent recovery joins
      // until it settles. Mirrored in the PWA's leave / delete hooks.
      await runGuardedDeparture(
        () => {
          assertSameServer();
          return apiClient.leaveFamily(familyId, userId, currentSecret);
        },
        (response) => {
          refused.error = settleLeave(response);
        },
      );
      if (refused.error) {
        assertSameServer();
        await settleLeaveError(refused.error, asked);
      }
    } catch (err) {
      setLeaveError(
        err instanceof Error ? err.message : "離開家庭失敗，請稍後再試",
      );
      setLeaveState("idle");
    }
  };

  return {
    leaveState,
    setLeaveState,
    leaveError,
    setLeaveError,
    requiredMethod,
    secretError,
    startConfirming,
    handleLeaveConfirm,
  };
}
