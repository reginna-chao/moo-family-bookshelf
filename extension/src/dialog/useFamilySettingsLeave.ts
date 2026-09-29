import { useState } from "react";
import type { ApiClient } from "../api/client";
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

  const handleLeaveConfirm = async () => {
    setLeaveState("leaving");
    setLeaveError("");
    try {
      const response = await apiClient.leaveFamily(familyId, userId);
      // Self-leave, so MEMBER_NOT_FOUND can only mean "already not a member":
      // an earlier leave half-failed server-side (member list updated, revoke
      // failed) and this retry has now finished it. Treat it as success —
      // showing an error and keeping the local family lets silent recovery
      // re-join the family the user just left. FAMILY_NOT_FOUND is the same
      // outcome: with the family record gone there is nothing left to leave —
      // a sole-owner dissolve that half-failed after deleting the record (its
      // retries keep answering this 404), or a family dissolved meanwhile —
      // and keeping the local family would strand the user on a family that
      // no longer exists. Mirrored in pwa/src/hooks/useLeaveFamily.ts
      // handleLeave; keep the two identical.
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
              safeErrorText(
                response.error.message,
                "離開家庭失敗，請稍後再試",
              ));
        setLeaveError(msg);
        setLeaveState("idle");
        return;
      }
      onLeave();
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "發生未知錯誤");
      setLeaveState("idle");
    }
  };

  return { leaveState, setLeaveState, leaveError, handleLeaveConfirm };
}
