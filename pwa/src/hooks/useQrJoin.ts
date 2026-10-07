import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { decodeSyncCode } from "@/crypto/syncCode";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { isUnsafeApiHost, UNSAFE_API_HOST_ERROR } from "@/utils/apiHostGuard";
import type {
  JoinOrigin,
  PendingAuth,
  PendingHostConsent,
} from "@/hooks/joinState";

export interface UseQrJoinParams {
  /** Pre-hashed userId from QR code; empty when this is not a QR arrival. */
  qrUserId: string;
  /** Pre-filled sync code from QR code, invite link, or remembered logout. */
  initialSyncCode: string;
  /** Short-lived QR token from Extension; empty string when the QR carried none. */
  qrToken: string;
  /** The page's single join choke point — every QR exit routes through it. */
  completeJoin: (
    familyId: string,
    userId: string,
    apiHost?: string,
    verifySecret?: string,
    tokenFromQr?: string,
  ) => Promise<void>;
  /** The page's per-host `ApiClient` cache. */
  getJoinClient: (host: string | undefined) => ApiClient;
  setJoinOrigin: Dispatch<SetStateAction<JoinOrigin | null>>;
  setGeneralError: Dispatch<SetStateAction<string>>;
  setPendingAuth: Dispatch<SetStateAction<PendingAuth | null>>;
}

export interface UseQrJoinResult {
  /** Non-null while a QR arrival waits at the custom-host consent gate. */
  hostConsent: PendingHostConsent | null;
  handleHostConsentConfirm: () => void;
  handleHostConsentCancel: () => void;
}

/**
 * The QR-arrival half of the landing page: decode the scanned sync code, take
 * consent when it carries a custom `@host`, and start that join.
 *
 * Ownership split — the page's join hooks keep the join machinery
 * (`completeJoin` in `useLandingCompleteJoin.ts`, the `ApiClient` cache in
 * `useLandingJoinClient.ts`) and, deliberately, the `joinOrigin` state in
 * `useLandingJoin.ts`: the manual FORM path sets and reads it too, and there
 * must be exactly one owner of "something is in flight" (see `JoinOrigin` in
 * `joinState.ts` for why that is one field and not two flags). This hook owns
 * only what exists for the QR path alone — the consent gate and the one-shot
 * auto-trigger. It receives the RAW state setters, so a QR-driven transition
 * is the same assignment `useLandingJoin` would have made inline.
 */
export function useQrJoin({
  qrUserId,
  initialSyncCode,
  qrToken,
  completeJoin,
  getJoinClient,
  setJoinOrigin,
  setGeneralError,
  setPendingAuth,
}: UseQrJoinParams): UseQrJoinResult {
  // Custom-host consent state (QR arrivals whose sync code carries an `@host`)
  const [hostConsent, setHostConsent] = useState<PendingHostConsent | null>(
    null,
  );

  /** Runs a QR arrival's join via the exit its credentials fit (a qrToken skips verification);
   *  shared by the fast path and the consent handler. See docs/architecture.md → 登入頁的加入流程. */
  function startQrJoin(
    familyId: string,
    userId: string,
    apiHost: string | undefined,
    tokenFromQr: string,
  ) {
    setJoinOrigin("qr");

    if (tokenFromQr) {
      // No `.catch` on either `completeJoin` call in this function: it catches and reports its own
      // failures, so it never rejects.
      void completeJoin(familyId, userId, apiHost, undefined, tokenFromQr);
      return;
    }

    // The probe is the first request to this host, so it gets `completeJoin`'s refusal too — this
    // function's own invariant, not a promise its callers happen to keep.
    if (isUnsafeApiHost(apiHost)) {
      setGeneralError(UNSAFE_API_HOST_ERROR);
      setJoinOrigin(null);
      return;
    }
    const joinClient = getJoinClient(apiHost);
    void joinClient
      .getVerifyMethod(userId)
      .then((verifyRes) => {
        const method: VerifyMethod = verifyRes.data?.method ?? "none";

        if (method !== "none") {
          setPendingAuth({ userId, familyId, apiHost, verifyMethod: method });
          setJoinOrigin(null);
          return;
        }

        // No verification needed — join directly
        void completeJoin(familyId, userId, apiHost);
      })
      .catch(() => {
        setGeneralError("處理失敗，請重試。");
        setJoinOrigin(null);
      });
  }

  function handleHostConsentConfirm() {
    if (!hostConsent) return;
    setHostConsent(null);
    startQrJoin(
      hostConsent.familyId,
      hostConsent.userId,
      hostConsent.apiHost,
      hostConsent.qrToken,
    );
  }

  /** Drop back to the manual form, sync code still pre-filled (its `SyncCodeHostNote` keeps the
   *  address on screen). `qrTriggered` is latched, so the effect cannot re-fire behind this. */
  function handleHostConsentCancel() {
    setHostConsent(null);
  }

  // Auto-trigger login when QR code provides both sync code and userId.
  const qrTriggered = useRef(false);
  useEffect(() => {
    if (!qrUserId || !initialSyncCode || qrTriggered.current) return;
    qrTriggered.current = true;

    let decoded;
    try {
      decoded = decodeSyncCode(initialSyncCode);
    } catch {
      setGeneralError("QR Code 同步碼解析失敗，請手動輸入。");
      return;
    }

    // A QR / invite host was never typed by this user, so it gets the same
    // refusal as a pasted one — before the verify-method probe below.
    if (isUnsafeApiHost(decoded.apiHost)) {
      setGeneralError(UNSAFE_API_HOST_ERROR);
      return;
    }

    // A present `@host` is now `valid` but never seen: hold EVERY request (the probe alone leaks
    // IP / UA) behind consent — docs/architecture.md → 同步碼位址的驗證與揭露.
    const { apiHost } = decoded;
    if (apiHost) {
      setHostConsent({
        familyId: decoded.familyId,
        userId: qrUserId,
        apiHost,
        qrToken,
      });
      return;
    }

    // No `@host` — the official default endpoint. Nothing to disclose, so the
    // main onboarding path stays zero-interaction.
    startQrJoin(decoded.familyId, qrUserId, undefined, qrToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrUserId, initialSyncCode, qrToken]);

  return { hostConsent, handleHostConsentConfirm, handleHostConsentCancel };
}
