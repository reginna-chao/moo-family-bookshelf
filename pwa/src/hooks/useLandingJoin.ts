import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ApiClient } from "@/api/client";
import type { AuthState } from "@/hooks/useAuth";
import { useQrJoin } from "@/hooks/useQrJoin";
import type { UseQrJoinResult } from "@/hooks/useQrJoin";
import type { JoinOrigin, PendingAuth } from "@/hooks/joinState";
import { useLandingJoinClient } from "@/hooks/useLandingJoinClient";
import { useLandingRetryLock } from "@/hooks/useLandingRetryLock";
import type { UseLandingRetryLockResult } from "@/hooks/useLandingRetryLock";
import { useLandingCompleteJoin } from "@/hooks/useLandingCompleteJoin";
import type { CompleteJoin } from "@/hooks/useLandingCompleteJoin";

export interface UseLandingJoinParams {
  onAuth: (data: AuthState) => void;
  initialSyncCode: string;
  qrUserId: string;
  qrToken: string;
}

export interface UseLandingJoinResult
  extends UseQrJoinResult, UseLandingRetryLockResult {
  getJoinClient: (host: string | undefined) => ApiClient;
  generalError: string;
  setGeneralError: Dispatch<SetStateAction<string>>;
  joinOrigin: JoinOrigin | null;
  setJoinOrigin: Dispatch<SetStateAction<JoinOrigin | null>>;
  isSubmitting: boolean;
  pendingAuth: PendingAuth | null;
  setPendingAuth: Dispatch<SetStateAction<PendingAuth | null>>;
  verifyError: string;
  codeInput: string;
  setCodeInput: Dispatch<SetStateAction<string>>;
  completeJoin: CompleteJoin;
  handleVerifyComplete: (secret: string) => void;
  handleVerifyCancel: () => void;
}

/**
 * The landing page's join state and machinery: the in-flight origin, the
 * verification challenge, the back-off lock, the join choke point and the QR
 * arrival path. Called by the always-mounted `LandingPage`, so none of this
 * state is tied to whichever screen happens to be showing.
 */
export function useLandingJoin({
  onAuth,
  initialSyncCode,
  qrUserId,
  qrToken,
}: UseLandingJoinParams): UseLandingJoinResult {
  const getJoinClient = useLandingJoinClient();

  const [generalError, setGeneralError] = useState("");
  const [joinOrigin, setJoinOrigin] = useState<JoinOrigin | null>(null);
  /** Derived: "something is in flight" has exactly one owner, `joinOrigin`. */
  const isSubmitting = joinOrigin !== null;

  // Verification state
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [verifyError, setVerifyError] = useState("");
  const [codeInput, setCodeInput] = useState("");

  const retryLock = useLandingRetryLock();
  const { retryBlocked, startRetryLock, clearRetryLock } = retryLock;

  const completeJoin = useLandingCompleteJoin({
    onAuth,
    getJoinClient,
    pendingAuth,
    setPendingAuth,
    setGeneralError,
    setJoinOrigin,
    setVerifyError,
    startRetryLock,
    setCodeInput,
  });

  function handleVerifyComplete(secret: string) {
    if (!pendingAuth || retryBlocked) return;
    setVerifyError("");
    clearRetryLock();
    void completeJoin(
      pendingAuth.familyId,
      pendingAuth.userId,
      pendingAuth.apiHost,
      secret,
    );
  }

  function handleVerifyCancel() {
    setPendingAuth(null);
    setVerifyError("");
    setCodeInput("");
  }

  // The QR arrival's consent gate + one-shot auto-trigger; it gets raw setters because it does
  // not own the state the form path shares (`joinOrigin`, `pendingAuth`, `generalError`).
  const { hostConsent, handleHostConsentConfirm, handleHostConsentCancel } =
    useQrJoin({
      qrUserId,
      initialSyncCode,
      qrToken,
      completeJoin,
      getJoinClient,
      setJoinOrigin,
      setGeneralError,
      setPendingAuth,
    });

  return {
    ...retryLock,
    hostConsent,
    handleHostConsentConfirm,
    handleHostConsentCancel,
    getJoinClient,
    generalError,
    setGeneralError,
    joinOrigin,
    setJoinOrigin,
    isSubmitting,
    pendingAuth,
    setPendingAuth,
    verifyError,
    codeInput,
    setCodeInput,
    completeJoin,
    handleVerifyComplete,
    handleVerifyCancel,
  };
}
