import { useState } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient } from "@/api/client";
import { rateLimitedEnvelopeMessage } from "@/utils/retryMessage";
import { runGuardedDeparture } from "@/utils/selfDeparture";

export type LeaveState = "idle" | "confirming" | "leaving";

interface UseLeaveFamilyOptions {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLogout: () => void;
}

export interface LeaveFamilyFlow {
  leaveState: LeaveState;
  setLeaveState: (state: LeaveState) => void;
  leaveError: string | null;
  setLeaveError: (error: string | null) => void;
  handleLeave: () => Promise<void>;
}

/** The caller's own "leave family" flow: confirm → leave → log out. */
export function useLeaveFamily({
  familyId,
  userId,
  apiClient,
  onLogout,
}: UseLeaveFamilyOptions): LeaveFamilyFlow {
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState<string | null>(null);

  function settleLeave(res: ApiResponse<{ ok: boolean }>) {
    // MEMBER_NOT_FOUND / FAMILY_NOT_FOUND on a self-leave mean "already left": treat as success.
    // Why: docs/architecture.md → 移除成員與離開家庭的重試; Extension twin in .claude/rules/frontend.md.
    const code = res.error?.code;
    const alreadyLeft =
      code === "MEMBER_NOT_FOUND" || code === "FAMILY_NOT_FOUND";
    if (alreadyLeft) {
      onLogout();
      return;
    }
    if (res.error) {
      // 429 shows the localized back-off copy (with the wait when the server
      // sent one) instead of the server's English message.
      const msg =
        res.error.code === "OWNER_CANNOT_LEAVE"
          ? "管理者必須先轉移管理權才能離開家庭"
          : (rateLimitedEnvelopeMessage(res.error) ??
            safeErrorText(res.error.message, "離開家庭失敗，請稍後再試"));
      setLeaveError(msg);
      setLeaveState("idle");
      return;
    }
    onLogout();
  }

  async function handleLeave() {
    setLeaveState("leaving");
    setLeaveError(null);
    try {
      // Own departure in flight (#263): the helper blocks silent recovery joins
      // until it settles. Mirrored in the Extension's leave / delete hooks.
      await runGuardedDeparture(
        () => apiClient.leaveFamily(familyId, userId),
        settleLeave,
      );
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "離開失敗");
      setLeaveState("idle");
    }
  }

  return { leaveState, setLeaveState, leaveError, setLeaveError, handleLeave };
}
