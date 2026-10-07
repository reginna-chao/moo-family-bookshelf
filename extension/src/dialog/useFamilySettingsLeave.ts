import { useState } from "react";
import type { ApiClient } from "../api/client";
import type { ApiResponse } from "../api/types";
import { runGuardedDeparture } from "../storage/selfDeparture";
import { rateLimitedEnvelopeMessage } from "./verificationMessages";
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
  handleLeaveConfirm: () => Promise<void>;
}

/** Leave-family confirm flow behind the 離開家庭 button in FamilySettings. */
export function useFamilySettingsLeave({
  familyId,
  userId,
  apiClient,
  onLeave,
}: UseFamilySettingsLeaveOptions): UseFamilySettingsLeaveResult {
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState("");

  const settleLeave = (response: ApiResponse<{ ok: boolean }>) => {
    // MEMBER_NOT_FOUND / FAMILY_NOT_FOUND on a self-leave mean "already left": treat as success.
    // Why: docs/architecture.md → 移除成員與離開家庭的重試; PWA twin in .claude/rules/frontend.md.
    const code = response.error?.code;
    const alreadyLeft =
      code === "MEMBER_NOT_FOUND" || code === "FAMILY_NOT_FOUND";
    if (alreadyLeft) {
      onLeave();
      return;
    }
    if (response.error) {
      // 429 shows the localized back-off copy (with the wait when the server
      // sent one) instead of the server's English message.
      const msg =
        response.error.code === "OWNER_CANNOT_LEAVE"
          ? "管理者必須先轉移管理權才能離開家庭"
          : (rateLimitedEnvelopeMessage(response.error) ??
            safeErrorText(response.error.message, "離開家庭失敗，請稍後再試"));
      setLeaveError(msg);
      setLeaveState("idle");
      return;
    }
    onLeave();
  };

  const handleLeaveConfirm = async () => {
    setLeaveState("leaving");
    setLeaveError("");
    try {
      // Own departure in flight (#263): the helper blocks silent recovery joins
      // until it settles. Mirrored in the PWA's leave / delete hooks.
      await runGuardedDeparture(
        () => apiClient.leaveFamily(familyId, userId),
        settleLeave,
      );
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "發生未知錯誤");
      setLeaveState("idle");
    }
  };

  return { leaveState, setLeaveState, leaveError, handleLeaveConfirm };
}
