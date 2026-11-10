import { useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import type { ApiErrorPayload, ApiResponse, VerifyMethod } from "../api/types";
import { runGuardedDeparture } from "../storage/selfDeparture";
import { pinDepartureServer } from "./departureServerPin";
import { readVerifyMethod, recoverStepUp } from "./stepUp";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";

export type LeaveState = "idle" | "confirming" | "leaving";

type ServerCheck = () => void;

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
  const [leaveState, setRawLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState("");
  const [requiredMethod, setRequiredMethod] = useState<VerifyMethod | null>(
    null,
  );
  const [secretError, setSecretError] = useState("");
  // The server pinned when this confirm session opened; every send reuses it, never re-pins.
  // Why: docs/architecture.md → 離開家庭時一併清除.
  const serverCheckRef = useRef<ServerCheck | null>(null);

  // Back at idle the confirm session is over: the next startConfirming() pins afresh.
  const setLeaveState = (state: LeaveState) => {
    if (state === "idle") serverCheckRef.current = null;
    setRawLeaveState(state);
  };

  const failLeave = (err: unknown) => {
    setLeaveError(
      err instanceof Error ? err.message : "離開家庭失敗，請稍後再試",
    );
    setLeaveState("idle");
  };

  const startConfirming = async () => {
    setLeaveError("");
    setSecretError("");
    try {
      const assertSameServer = pinDepartureServer(apiClient);
      serverCheckRef.current = assertSameServer;
      const method = await readVerifyMethod(apiClient, userId);
      // A later startConfirming() owns the confirm step now.
      if (serverCheckRef.current !== assertSameServer) return;
      assertSameServer();
      setRequiredMethod(method);
      setLeaveState("confirming");
    } catch (err) {
      failLeave(err);
    }
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
      // Pin at the press only when no confirm session pinned (startConfirming never ran).
      const assertSameServer =
        serverCheckRef.current ?? pinDepartureServer(apiClient);
      serverCheckRef.current = assertSameServer;
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
        return;
      }
      serverCheckRef.current = null;
    } catch (err) {
      failLeave(err);
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
