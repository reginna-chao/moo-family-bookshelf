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
    // Self-leave, so MEMBER_NOT_FOUND can only mean "already not a member":
    // an earlier leave half-failed server-side (member list updated, revoke
    // failed) and this retry has now finished it. Treat it as success —
    // showing an error and keeping the session lets the next request's
    // recovery re-join the family the user just left. FAMILY_NOT_FOUND is
    // the same outcome: with the family record gone there is nothing left
    // to leave — a sole-owner dissolve that half-failed after deleting the
    // record (its retries keep answering this 404), or a family dissolved
    // meanwhile — and keeping the session would strand the user on a family
    // that no longer exists. Mirrored in
    // extension/src/dialog/useFamilySettingsLeave.ts settleLeave;
    // keep the two identical.
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
