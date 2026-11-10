// Twin: pwa/src/hooks/useTransferOwnership.ts — the Extension adds clearEndpoint, activeAction and notice.
import { useRef, useState } from "react";
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiClient } from "../api/client";
import type { ApiErrorPayload, VerifyMethod } from "../api/types";
import { pinDepartureServer } from "./departureServerPin";
import { readVerifyMethod, recoverStepUp } from "./stepUp";

type ServerCheck = () => void;

/** Which endpoint choice was pressed, so only that button shows 處理中. */
export type TransferAction = "keep" | "clear";

export interface UseTransferOwnershipOptions {
  familyId: string;
  userId: string;
  /** The member who becomes owner; the only source of the transfer target. */
  targetId: string;
  apiClient: ApiClient;
  /** A new attempt starts; the caller clears its own error. */
  onStart: () => void;
  onTransferred: () => void;
  /** The transfer failed with `message`; the caller closes the confirm. */
  onFailed: (message: string) => void;
}

export interface UseTransferOwnershipResult {
  loading: boolean;
  activeAction: TransferAction | null;
  /** PIN / pattern whose current secret is being asked for; null on the confirm screen. */
  secretMethod: VerifyMethod | null;
  secretError: string;
  /** Bumped when a response keeps the secret step; the caller keys the entry on it so it remounts empty. */
  secretAttempt: number;
  /** Shown on the confirm screen when the server asked for a secret this account no longer has. */
  notice: string;
  start: (clearEndpoint?: 1, action?: TransferAction) => Promise<void>;
  submitSecret: (secret: string) => Promise<void>;
  reset: () => void;
}

/**
 * Ownership-transfer flow behind MemberList's 轉移管理權 confirm. A PIN /
 * pattern account sends its current secret with the transfer; the secret is
 * a parameter only, never kept in state or storage. The whole run stays on
 * the server it started on (`pinDepartureServer`).
 */
export function useTransferOwnership({
  familyId,
  userId,
  targetId,
  apiClient,
  onStart,
  onTransferred,
  onFailed,
}: UseTransferOwnershipOptions): UseTransferOwnershipResult {
  const [loading, setLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<TransferAction | null>(null);
  const [secretMethod, setSecretMethod] = useState<VerifyMethod | null>(null);
  const [secretError, setSecretError] = useState("");
  const [secretAttempt, setSecretAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  // The endpoint choice made on the confirm screen, resent with the secret.
  const clearEndpointRef = useRef<1 | undefined>(undefined);
  // The server pinned by start() for this run; the secret step reuses it, never re-pins.
  // Why: docs/architecture.md → 離開家庭時一併清除.
  const serverCheckRef = useRef<ServerCheck | null>(null);

  const fail = (err: unknown) => {
    setLoading(false);
    setActiveAction(null);
    setSecretAttempt((n) => n + 1);
    onFailed(err instanceof Error ? err.message : "發生未知錯誤");
  };

  /** A refused transfer; `asked` is the method whose current secret was sent (null: none was). */
  const settleError = async (
    error: ApiErrorPayload,
    asked: VerifyMethod | null,
    assertSameServer: ServerCheck,
  ) => {
    assertSameServer();
    const next = await recoverStepUp(apiClient, userId, error, asked);
    setLoading(false);
    if (next?.kind === "ask") {
      setActiveAction(null);
      setSecretMethod(next.method);
      setSecretError(next.error);
      setSecretAttempt((n) => n + 1);
      return;
    }
    setActiveAction(null);
    if (next !== null && error.code === "VERIFICATION_REQUIRED") {
      setSecretMethod(null);
      setNotice(next.error);
      return;
    }
    onFailed(
      next?.error ?? safeErrorText(error.message, "轉移管理權失敗，請稍後再試"),
    );
  };

  const send = async (assertSameServer: ServerCheck, secret?: string) => {
    const asked = secret === undefined ? null : secretMethod;
    try {
      assertSameServer();
      const response = await apiClient.transferOwnership(
        familyId,
        userId,
        targetId,
        clearEndpointRef.current,
        secret,
      );
      if (response.error) {
        await settleError(response.error, asked, assertSameServer);
        return;
      }
      setLoading(false);
      onTransferred();
    } catch (err) {
      fail(err);
    }
  };

  const start = async (clearEndpoint?: 1, action?: TransferAction) => {
    try {
      const assertSameServer = pinDepartureServer(apiClient);
      serverCheckRef.current = assertSameServer;
      setLoading(true);
      setActiveAction(action ?? null);
      setNotice("");
      onStart();
      clearEndpointRef.current = clearEndpoint;
      const method = await readVerifyMethod(apiClient, userId);
      assertSameServer();
      if (method !== null && requiresCurrentSecret(method)) {
        setSecretMethod(method);
        setSecretError("");
        setActiveAction(null);
        setLoading(false);
        return;
      }
      await send(assertSameServer);
    } catch (err) {
      fail(err);
    }
  };

  const submitSecret = async (secret: string) => {
    const assertSameServer = serverCheckRef.current;
    // No pinned run (reset, or start() never ran): nothing to continue, send nothing.
    if (assertSameServer === null) return;
    setLoading(true);
    setSecretError("");
    await send(assertSameServer, secret);
  };

  const reset = () => {
    serverCheckRef.current = null;
    setSecretMethod(null);
    setSecretError("");
    setNotice("");
    setActiveAction(null);
    setLoading(false);
  };

  return {
    loading,
    activeAction,
    secretMethod,
    secretError,
    secretAttempt,
    notice,
    start,
    submitSecret,
    reset,
  };
}
