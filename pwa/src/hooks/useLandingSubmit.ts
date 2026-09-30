import type { Dispatch, FormEvent, SetStateAction } from "react";
import { decodeSyncCode, SyncCodeError } from "@/crypto/syncCode";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { REMEMBER_SYNC_CODE_KEY } from "@/hooks/useAuth";
import type { UseSyncCodeHostVerdictResult } from "@/hooks/useSyncCodeHostVerdict";
import { isUnsafeApiHost, UNSAFE_API_HOST_ERROR } from "@/utils/apiHostGuard";
import type { JoinOrigin, PendingAuth } from "@/hooks/joinState";
import type { CompleteJoin } from "@/hooks/useLandingCompleteJoin";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UseLandingSubmitParams {
  syncCodeInput: string;
  email: string;
  rememberSyncCode: boolean;
  hostVerdict: Pick<UseSyncCodeHostVerdictResult, "settleNow">;
  retryBlocked: boolean;
  setSyncCodeError: Dispatch<SetStateAction<string>>;
  setEmailError: Dispatch<SetStateAction<string>>;
  setGeneralError: Dispatch<SetStateAction<string>>;
  clearRetryLock: () => void;
  setJoinOrigin: Dispatch<SetStateAction<JoinOrigin | null>>;
  /** The page's per-host `ApiClient` cache. */
  getJoinClient: (host: string | undefined) => ApiClient;
  setPendingAuth: Dispatch<SetStateAction<PendingAuth | null>>;
  completeJoin: CompleteJoin;
}

/** Builds the manual form's submit handler for the current render. */
export function useLandingSubmit({
  syncCodeInput,
  email,
  rememberSyncCode,
  hostVerdict,
  retryBlocked,
  setSyncCodeError,
  setEmailError,
  setGeneralError,
  clearRetryLock,
  setJoinOrigin,
  getJoinClient,
  setPendingAuth,
  completeJoin,
}: UseLandingSubmitParams): (e: FormEvent) => Promise<void> {
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Submitting ends the editing session, so the warning must not wait.
    hostVerdict.settleNow();
    if (retryBlocked) return;
    setSyncCodeError("");
    setEmailError("");
    setGeneralError("");
    clearRetryLock();

    const trimmedCode = syncCodeInput.trim();

    if (!trimmedCode) {
      setSyncCodeError("請輸入同步碼。");
      return;
    }

    // Decode sync code
    let decoded;
    try {
      decoded = decodeSyncCode(trimmedCode);
    } catch (err) {
      if (err instanceof SyncCodeError) {
        setSyncCodeError("同步碼格式不正確，請確認後重新輸入。");
      } else {
        setSyncCodeError("同步碼解析失敗，請重試。");
      }
      return;
    }

    // Refuse an unsafe `@host` before anything reaches it — the verify-method
    // probe below already goes to that server.
    if (isUnsafeApiHost(decoded.apiHost)) {
      setSyncCodeError(UNSAFE_API_HOST_ERROR);
      return;
    }

    // Validate email
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailError("請輸入 Email。");
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setEmailError("Email 格式不正確。");
      return;
    }

    // Persist remember preference
    localStorage.setItem(REMEMBER_SYNC_CODE_KEY, rememberSyncCode ? "1" : "0");

    setJoinOrigin("form");

    try {
      const userId = await deriveUserId(trimmedEmail);
      const joinClient = getJoinClient(decoded.apiHost);

      // Check verification method before joining
      const verifyRes = await joinClient.getVerifyMethod(userId);
      const method: VerifyMethod = verifyRes.data?.method ?? "none";

      if (method !== "none") {
        setPendingAuth({
          userId,
          familyId: decoded.familyId,
          apiHost: decoded.apiHost,
          verifyMethod: method,
        });
        setJoinOrigin(null);
        return;
      }

      // No verification needed — join directly
      await completeJoin(decoded.familyId, userId, decoded.apiHost);
    } catch {
      setGeneralError("處理失敗，請重試。");
      setJoinOrigin(null);
    }
  }

  return handleSubmit;
}
