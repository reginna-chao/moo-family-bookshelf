import { useState } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type {
  ApiErrorPayload,
  ApiResponse,
} from "moo-family-bookshelf-shared/api/types";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { readVerifyMethod, recoverStepUp } from "@/hooks/stepUp";
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
  /** The method read when the confirm opened; null when that read failed. */
  requiredMethod: VerifyMethod | null;
  /** Error shown on the current-PIN / pattern entry. */
  secretError: string;
  /** Read the account's method once, then open the confirm step. */
  startConfirming: () => Promise<void>;
  handleLeave: (currentSecret?: string) => Promise<void>;
}

/**
 * The caller's own "leave family" flow: confirm → leave → log out. A PIN /
 * pattern account sends its current secret with the leave; the secret is a
 * parameter only, never kept in state or storage.
 */
export function useLeaveFamily({
  familyId,
  userId,
  apiClient,
  onLogout,
}: UseLeaveFamilyOptions): LeaveFamilyFlow {
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [requiredMethod, setRequiredMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [secretError, setSecretError] = useState("");

  async function startConfirming() {
    setLeaveError(null);
    setSecretError("");
    setRequiredMethod(await readVerifyMethod(apiClient, userId));
    setLeaveState("confirming");
  }

  /** Ends in onLogout() on success; any other refusal is returned for handling after the guard. */
  function settleLeave(
    res: ApiResponse<{ ok: boolean }>,
  ): ApiErrorPayload | undefined {
    // MEMBER_NOT_FOUND / FAMILY_NOT_FOUND on a self-leave mean "already left": treat as success.
    // Why: docs/architecture.md → 移除成員與離開家庭的重試; Extension twin in .claude/rules/frontend.md.
    const code = res.error?.code;
    const alreadyLeft =
      code === "MEMBER_NOT_FOUND" || code === "FAMILY_NOT_FOUND";
    if (res.error && !alreadyLeft) return res.error;
    onLogout();
    return undefined;
  }

  /** A refused leave; `asked` is the method whose current secret was sent (null: none was). */
  async function settleLeaveError(
    error: ApiErrorPayload,
    asked: VerifyMethod | null,
  ) {
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
  }

  async function handleLeave(currentSecret?: string) {
    setLeaveState("leaving");
    setLeaveError(null);
    setSecretError("");
    const asked = currentSecret === undefined ? null : requiredMethod;
    // The refusal is handled after the guard ends: its re-read of the method is no departure.
    const refused: { error?: ApiErrorPayload } = {};
    try {
      // Own departure in flight (#263): the helper blocks silent recovery joins
      // until it settles. Mirrored in the Extension's leave / delete hooks.
      await runGuardedDeparture(
        () => apiClient.leaveFamily(familyId, userId, currentSecret),
        (res) => {
          refused.error = settleLeave(res);
        },
      );
      if (refused.error) await settleLeaveError(refused.error, asked);
    } catch (err) {
      setLeaveError(
        err instanceof Error ? err.message : "離開家庭失敗，請稍後再試",
      );
      setLeaveState("idle");
    }
  }

  return {
    leaveState,
    setLeaveState,
    leaveError,
    setLeaveError,
    requiredMethod,
    secretError,
    startConfirming,
    handleLeave,
  };
}
