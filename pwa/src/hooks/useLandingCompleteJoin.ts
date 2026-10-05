import type { Dispatch, SetStateAction } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient, VerifyMethod } from "@/api/client";
import type { AuthState } from "@/hooks/useAuth";
import { isUnsafeApiHost, UNSAFE_API_HOST_ERROR } from "@/utils/apiHostGuard";
import {
  FAMILY_FULL_MESSAGE,
  RECOVERY_NOT_MEMBER_LANDING_MESSAGE,
} from "@/utils/joinErrorMessages";
import { clearReauthPending, isReauthPendingFor } from "@/utils/reauthPending";
import type { JoinOrigin, PendingAuth } from "@/hooks/joinState";
import type { RetryErrorCode } from "@/utils/retryMessage";

export interface UseLandingCompleteJoinParams {
  onAuth: (data: AuthState) => void;
  /** The page's per-host `ApiClient` cache. */
  getJoinClient: (host: string | undefined) => ApiClient;
  pendingAuth: PendingAuth | null;
  setPendingAuth: Dispatch<SetStateAction<PendingAuth | null>>;
  setGeneralError: Dispatch<SetStateAction<string>>;
  setJoinOrigin: Dispatch<SetStateAction<JoinOrigin | null>>;
  setVerifyError: Dispatch<SetStateAction<string>>;
  startRetryLock: (code: RetryErrorCode, retryAfter?: number) => void;
  setCodeInput: Dispatch<SetStateAction<string>>;
}

export type CompleteJoin = (
  familyId: string,
  userId: string,
  apiHost?: string,
  verifySecret?: string,
  tokenFromQr?: string,
) => Promise<void>;

/**
 * Builds the landing page's `completeJoin` for the current render — the single
 * join choke point shared by the form, the verification prompt and the QR path.
 */
export function useLandingCompleteJoin({
  onAuth,
  getJoinClient,
  pendingAuth,
  setPendingAuth,
  setGeneralError,
  setJoinOrigin,
  setVerifyError,
  startRetryLock,
  setCodeInput,
}: UseLandingCompleteJoinParams): CompleteJoin {
  async function completeJoin(
    familyId: string,
    userId: string,
    apiHost?: string,
    verifySecret?: string,
    tokenFromQr?: string,
  ) {
    // Single choke point for every join path (form, verification prompt, QR):
    // an address the client would refuse never gets a request, a token, or a
    // localStorage entry.
    if (isUnsafeApiHost(apiHost)) {
      setPendingAuth(null);
      setGeneralError(UNSAFE_API_HOST_ERROR);
      setJoinOrigin(null);
      return;
    }

    // An attempt already in flight keeps the origin it started with (the QR
    // path sets "qr" before calling in); a fresh entry from the verification
    // prompt is user-driven, so it counts as form-shaped.
    setJoinOrigin((prev) => prev ?? "form");
    try {
      const joinClient = getJoinClient(apiHost);
      // Re-login after a forced re-verification of THIS identity (#266): the
      // server then refuses to re-add a user who left meanwhile.
      const recovery = await isReauthPendingFor({ familyId, userId, apiHost });
      const joinRes = await joinClient.joinFamily(familyId, userId, {
        verifySecret,
        qrToken: tokenFromQr,
        ...(recovery ? { recovery: BoolFlag.TRUE } : {}),
      });
      if (joinRes.error) {
        const code = joinRes.error.code;
        const retryAfter = joinRes.error.retryAfter;
        const hasRetryHint = typeof retryAfter === "number" && retryAfter > 0;
        if (recovery && code === "RECOVERY_NOT_MEMBER") {
          // Marker spent, so the user's next submit is an explicit re-join.
          clearReauthPending();
          setVerifyError("");
          setPendingAuth(null);
          setCodeInput("");
          setGeneralError(RECOVERY_NOT_MEMBER_LANDING_MESSAGE);
        } else if (code === "FAMILY_FULL") {
          // Same entry the token-recovery path shows (App.tsx reads it out of
          // JOIN_BLOCKED_MESSAGES, which is built from this constant), so the
          // two join paths cannot report a full family differently.
          setGeneralError(FAMILY_FULL_MESSAGE);
        } else if (
          code === "VERIFICATION_REQUIRED" ||
          code === "VERIFICATION_FAILED"
        ) {
          // If QR token was used but rejected, fall back to verification UI
          if (tokenFromQr && !pendingAuth) {
            const verifyRes = await joinClient.getVerifyMethod(userId);
            const method: VerifyMethod = verifyRes.data?.method ?? "none";
            if (method !== "none") {
              setPendingAuth({
                userId,
                familyId,
                apiHost,
                verifyMethod: method,
              });
              if (code === "VERIFICATION_FAILED") {
                setVerifyError("QR 驗證碼已過期，請手動驗證。");
              }
              setJoinOrigin(null);
              return;
            }
          }
          if (code === "VERIFICATION_REQUIRED") {
            setVerifyError("需要驗證才能登入。");
          } else {
            setVerifyError("驗證失敗，請重新輸入。");
          }
        } else if (code === "VERIFICATION_LOCKED") {
          // Lockout is server-side, so drop the challenge UI and surface the
          // wait on the form. Without `retryAfter` the copy stays static.
          setVerifyError("");
          startRetryLock("VERIFICATION_LOCKED", retryAfter);
          setPendingAuth(null);
          // Drop the rejected OTP so a re-opened prompt starts empty.
          setCodeInput("");
        } else if (code === "RATE_LIMITED" && hasRetryHint) {
          // Keep the challenge UI mounted: the user may retry once the window
          // clears. Quota errors without a hint fall through to generic copy.
          setVerifyError("");
          startRetryLock("RATE_LIMITED", retryAfter);
        } else {
          setGeneralError(
            safeErrorText(joinRes.error.message, "加入家庭失敗，請重試。"),
          );
        }
        setJoinOrigin(null);
        return;
      }

      // Deliberately no `setJoinOrigin(null)` on this exit: the parent swaps
      // this page out on `onAuth`, and "still working" is the honest screen
      // until it does. Every exit that stays on this page clears the origin.
      setPendingAuth(null);
      // Only the join that used the marker spends it: another identity's login keeps it (#266).
      if (recovery) clearReauthPending();
      onAuth({
        userId,
        familyId,
        apiHost,
        authToken: joinRes.data?.authToken,
      });
    } catch {
      setGeneralError("處理失敗，請重試。");
      setJoinOrigin(null);
    }
  }

  return completeJoin;
}
