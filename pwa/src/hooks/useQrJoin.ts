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
 * Ownership split — the page keeps the join machinery (`completeJoin`, the
 * `ApiClient` cache) and, deliberately, the `joinOrigin` state: the manual FORM
 * path sets and reads it too, and there must be exactly one owner of "something
 * is in flight" (see `JoinOrigin` in `joinState.ts` for why that is one field
 * and not two flags). This hook owns only what exists for the QR path alone —
 * the consent gate and the one-shot auto-trigger. It receives the RAW state
 * setters, so a QR-driven transition is the same assignment the page would
 * have made inline.
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

  /**
   * Runs a QR arrival's join, picking the exit that fits the credentials it
   * carries. Shared by the default-endpoint fast path and the custom-host
   * consent handler so the branch logic exists exactly once — the two differ
   * only in WHEN they may start, never in what they do.
   *
   * With a qrToken, verification is skipped and the token is sent straight to
   * the join. If the server rejects it (expired/invalid) it answers
   * VERIFICATION_REQUIRED/FAILED and `completeJoin` falls back to the normal
   * verification UI.
   */
  function startQrJoin(
    familyId: string,
    userId: string,
    apiHost: string | undefined,
    tokenFromQr: string,
  ) {
    setJoinOrigin("qr");

    if (tokenFromQr) {
      // No `.catch` on purpose: `completeJoin` wraps its whole body in
      // try/catch and reports failures itself, so it never rejects — a handler
      // here would be dead code, and both call sites in this function stay
      // identical about that.
      void completeJoin(familyId, userId, apiHost, undefined, tokenFromQr);
      return;
    }

    // The probe is the first request to reach this host, so it gets the same
    // refusal `completeJoin` applies — the guard is this function's own
    // invariant, not a promise its callers happen to keep.
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

  /**
   * Drop back to the manual form. The sync code stays pre-filled (its own
   * `SyncCodeHostNote` keeps the address on screen), so the user can edit it or
   * simply walk away — the same shape as the invalid-host refusal. `qrTriggered`
   * is already latched, so the effect cannot re-fire behind this decision.
   */
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

    // Past that refusal, a present `@host` is exactly the `valid` case: a
    // usable address the user has still never seen. Disclose it and hold EVERY
    // request behind the answer — the verify-method probe alone would hand this
    // server the arriving device's IP / UA, which is precisely what an
    // unconsented address must not get.
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
