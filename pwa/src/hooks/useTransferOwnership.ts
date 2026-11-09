// Twin: extension/src/dialog/useTransferOwnership.ts — the Extension adds clearEndpoint, activeAction and notice.
import { useState } from "react";
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiErrorPayload } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { readVerifyMethod, recoverStepUp } from "@/hooks/stepUp";

interface UseTransferOwnershipOptions {
  familyId: string;
  userId: string;
  /** The member who becomes owner; the only source of the transfer target. */
  targetId: string;
  apiClient: ApiClient;
  /** A new attempt starts; the caller clears its own error. */
  onStart: () => void;
  onTransferred: () => void;
  /** The transfer failed with `message`; the caller keeps the confirm open. */
  onFailed: (message: string) => void;
}

export interface TransferOwnershipFlow {
  loading: boolean;
  /** PIN / pattern whose current secret is being asked for; null on the confirm screen. */
  secretMethod: VerifyMethod | null;
  secretError: string;
  /** Bumped when a response keeps the secret step; the caller keys the entry on it so it remounts empty. */
  secretAttempt: number;
  start: () => Promise<void>;
  submitSecret: (secret: string) => Promise<void>;
  reset: () => void;
}

/**
 * Ownership-transfer flow behind MemberList's 轉移管理權 confirm. A PIN /
 * pattern account sends its current secret with the transfer; the secret is
 * a parameter only, never kept in state or storage.
 */
export function useTransferOwnership({
  familyId,
  userId,
  targetId,
  apiClient,
  onStart,
  onTransferred,
  onFailed,
}: UseTransferOwnershipOptions): TransferOwnershipFlow {
  const [loading, setLoading] = useState(false);
  const [secretMethod, setSecretMethod] = useState<VerifyMethod | null>(null);
  const [secretError, setSecretError] = useState("");
  const [secretAttempt, setSecretAttempt] = useState(0);

  /** A refused transfer; `asked` is the method whose current secret was sent (null: none was). */
  async function settleError(
    error: ApiErrorPayload,
    asked: VerifyMethod | null,
  ) {
    const next = await recoverStepUp(apiClient, userId, error, asked);
    setLoading(false);
    if (next?.kind === "ask") {
      setSecretMethod(next.method);
      setSecretError(next.error);
      setSecretAttempt((n) => n + 1);
      return;
    }
    setSecretMethod(null);
    onFailed(
      next?.error ?? safeErrorText(error.message, "轉移管理權失敗，請稍後再試"),
    );
  }

  async function send(secret?: string) {
    const asked = secret === undefined ? null : secretMethod;
    try {
      const res = await apiClient.transferOwnership(
        familyId,
        userId,
        targetId,
        secret,
      );
      if (res.error) {
        await settleError(res.error, asked);
        return;
      }
      setLoading(false);
      onTransferred();
    } catch (err) {
      setLoading(false);
      setSecretAttempt((n) => n + 1);
      onFailed(err instanceof Error ? err.message : "操作失敗");
    }
  }

  async function start() {
    setLoading(true);
    onStart();
    const method = await readVerifyMethod(apiClient, userId);
    if (method !== null && requiresCurrentSecret(method)) {
      setSecretMethod(method);
      setSecretError("");
      setLoading(false);
      return;
    }
    await send();
  }

  async function submitSecret(secret: string) {
    setLoading(true);
    setSecretError("");
    await send(secret);
  }

  function reset() {
    setSecretMethod(null);
    setSecretError("");
    setLoading(false);
  }

  return {
    loading,
    secretMethod,
    secretError,
    secretAttempt,
    start,
    submitSecret,
    reset,
  };
}
