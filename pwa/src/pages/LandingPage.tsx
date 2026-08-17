import { useState, useEffect, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import { decodeSyncCode, SyncCodeError } from "@/crypto/syncCode";
import { deriveUserId } from "@/crypto/hash";
import { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/client";
import type { AuthState } from "@/hooks/useAuth";
import { REMEMBERED_LOGOUT_KEY, REMEMBER_SYNC_CODE_KEY } from "@/hooks/useAuth";
import { getAppEnv } from "@/utils/appEnv";
import { useRetryCountdown } from "@/hooks/useRetryCountdown";
import { useSyncCodeHostVerdict } from "@/hooks/useSyncCodeHostVerdict";
import {
  buildRetryMessage,
  buildStaticRetryMessage,
} from "@/utils/retryMessage";
import type { RetryErrorCode } from "@/utils/retryMessage";
import { PinInput } from "@/components/PinInput";
import { PatternLock } from "@/components/PatternLock";
import { ErrorAlert } from "@/components/ErrorAlert";
import { SyncCodeHostNote } from "@/components/SyncCodeHostNote";

interface LandingPageProps {
  onAuth: (data: AuthState) => void;
  /** Pre-filled sync code from QR code, invite link, or remembered logout. */
  initialSyncCode?: string;
  /** Pre-hashed userId from QR code. Skips email entry and auto-triggers login. */
  qrUserId?: string;
  /** Short-lived QR token from Extension. Bypasses verification when valid. */
  qrToken?: string;
  /** External error (e.g., FAMILY_FULL from token refresh). */
  externalError?: string;
}

/** Pending auth data waiting for verification completion. */
interface PendingAuth {
  userId: string;
  familyId: string;
  apiHost?: string;
  verifyMethod: VerifyMethod;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_ENV = getAppEnv();

/** Shown when a sync code's `@host` is one the API client refuses to adopt. */
const UNSAFE_API_HOST_ERROR = "此同步碼的伺服器位址無效或不安全，無法加入。";

/**
 * True when a sync code's `@host` would be REFUSED by `validateEndpointUrl`.
 *
 * Every path that would talk to that host must check first: the join client is
 * built from this value, so an unchecked reject means the PWA has already sent
 * a verify-method probe (and then an auth token) to an address the security
 * rules exist to keep it away from. Never adopt, never persist.
 */
function isUnsafeApiHost(apiHost: string | undefined): boolean {
  return classifySyncCodeApiHost(apiHost).kind === "invalid";
}

export function LandingPage({
  onAuth,
  initialSyncCode = "",
  qrUserId = "",
  qrToken = "",
  externalError = "",
}: LandingPageProps) {
  // Seeded from the prop so an invite-link / QR prefill is already in the field
  // at FIRST render: the verdict hook counts a never-typed value as settled, so
  // its `@host` note lands at once instead of waiting out the settle delay. The
  // effect below still covers a later `initialSyncCode` change.
  const [syncCodeInput, setSyncCodeInput] = useState(initialSyncCode);
  // Holds the `@host` warning back until the typed code settles, so it cannot
  // flash on every intermediate keystroke.
  const hostVerdict = useSyncCodeHostVerdict(syncCodeInput);
  const [showCode, setShowCode] = useState(false);
  const [email, setEmail] = useState("");
  const [rememberSyncCode, setRememberSyncCode] = useState(() => {
    return localStorage.getItem(REMEMBER_SYNC_CODE_KEY) !== "0";
  });

  // Cache join client per apiHost to avoid re-creating on each submit
  const joinClientRef = useRef<{
    host: string | undefined;
    client: ApiClient;
  } | null>(null);
  function getJoinClient(host: string | undefined): ApiClient {
    if (joinClientRef.current !== null && joinClientRef.current.host === host) {
      return joinClientRef.current.client;
    }
    const client = new ApiClient(host);
    joinClientRef.current = { host, client };
    return client;
  }

  // Pick up remembered sync code from localStorage (logout with "remember" enabled)
  useEffect(() => {
    const remembered = localStorage.getItem(REMEMBERED_LOGOUT_KEY);
    if (remembered) {
      localStorage.removeItem(REMEMBERED_LOGOUT_KEY);
      setSyncCodeInput(remembered);
    }
  }, []);

  // Update field if initialSyncCode changes (QR code, invite link, or remembered logout via state)
  useEffect(() => {
    if (initialSyncCode) {
      setSyncCodeInput(initialSyncCode);
    }
  }, [initialSyncCode]);

  const [syncCodeError, setSyncCodeError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [generalError, setGeneralError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Verification state
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [verifyError, setVerifyError] = useState("");
  const [codeInput, setCodeInput] = useState("");

  // Back-off state (429): the code drives the copy, the countdown the seconds.
  const [retryCode, setRetryCode] = useState<RetryErrorCode | null>(null);
  const retryCountdown = useRetryCountdown(() => setRetryCode(null));
  const retryMessage =
    retryCode === null
      ? ""
      : buildRetryMessage(retryCode, retryCountdown.remaining);
  /** Countdown-free twin of `retryMessage`, announced once instead of per tick.
   *  Undefined when no back-off notice is showing, so any other error copy —
   *  which never ticks — keeps announcing itself. */
  const retryAnnouncement =
    retryCode === null ? undefined : buildStaticRetryMessage(retryCode);
  /** True only while a countdown is running — blocks submit/verify actions. */
  const retryBlocked = retryCode !== null && retryCountdown.remaining > 0;

  /** Show a back-off notice; a positive `retryAfter` starts the live countdown. */
  function startRetryLock(code: RetryErrorCode, retryAfter?: number) {
    setRetryCode(code);
    retryCountdown.start(retryAfter ?? 0);
  }

  function clearRetryLock() {
    setRetryCode(null);
    retryCountdown.clear();
  }

  async function handleSubmit(e: React.FormEvent) {
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

    setIsSubmitting(true);

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
        setIsSubmitting(false);
        return;
      }

      // No verification needed — join directly
      await completeJoin(decoded.familyId, userId, decoded.apiHost);
    } catch {
      setGeneralError("處理失敗，請重試。");
      setIsSubmitting(false);
    }
  }

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
      setIsSubmitting(false);
      return;
    }

    setIsSubmitting(true);
    try {
      const joinClient = getJoinClient(apiHost);
      const joinRes = await joinClient.joinFamily(familyId, userId, {
        verifySecret,
        qrToken: tokenFromQr,
      });
      if (joinRes.error) {
        const code = joinRes.error.code;
        const retryAfter = joinRes.error.retryAfter;
        const hasRetryHint = typeof retryAfter === "number" && retryAfter > 0;
        if (code === "FAMILY_FULL") {
          setGeneralError("家庭成員已達上限（每個家庭最多 2 位成員）");
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
              setIsSubmitting(false);
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
          setGeneralError(joinRes.error.message || "加入家庭失敗，請重試。");
        }
        setIsSubmitting(false);
        return;
      }

      setPendingAuth(null);
      onAuth({
        userId,
        familyId,
        apiHost,
        authToken: joinRes.data?.authToken,
      });
    } catch {
      setGeneralError("處理失敗，請重試。");
      setIsSubmitting(false);
    }
  }

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

  // Auto-trigger login when QR code provides both sync code and userId.
  // When a qrToken is present, skip verification and join directly with the token.
  // If the token is invalid/expired, the server returns VERIFICATION_REQUIRED/FAILED
  // and we fall back to showing the normal verification UI.
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

    setIsSubmitting(true);

    // When qrToken is available, skip the verification check and join directly
    if (qrToken) {
      void completeJoin(
        decoded.familyId,
        qrUserId,
        decoded.apiHost,
        undefined,
        qrToken,
      ).catch(() => {
        setGeneralError("處理失敗，請重試。");
        setIsSubmitting(false);
      });
      return;
    }

    const joinClient = getJoinClient(decoded.apiHost);
    void joinClient
      .getVerifyMethod(qrUserId)
      .then((verifyRes) => {
        const method: VerifyMethod = verifyRes.data?.method ?? "none";

        if (method !== "none") {
          setPendingAuth({
            userId: qrUserId,
            familyId: decoded.familyId,
            apiHost: decoded.apiHost,
            verifyMethod: method,
          });
          setIsSubmitting(false);
          return;
        }

        // No verification needed — join directly
        void completeJoin(decoded.familyId, qrUserId, decoded.apiHost);
      })
      .catch(() => {
        setGeneralError("處理失敗，請重試。");
        setIsSubmitting(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrUserId, initialSyncCode, qrToken]);

  // Back-off copy wins over the per-attempt error: it carries the live
  // countdown. `generalError` is last so non-verification failures (a 429 with
  // no retryAfter, NOT_FOUND, …) stay visible while the challenge UI is open.
  const promptError = retryMessage || verifyError || generalError;

  // Show verification UI
  if (pendingAuth) {
    return (
      <div className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white">
        {/* QR / invite arrivals never see the form, so this is their only
            chance to learn which server they are about to authenticate to. */}
        <SyncCodeHostNote
          result={classifySyncCodeApiHost(pendingAuth.apiHost)}
          variant="verify"
          className="mb-4 w-full max-w-xs"
        />
        {pendingAuth.verifyMethod === "pin" && (
          <PinInput
            mode="verify"
            error={promptError}
            errorAnnouncement={retryAnnouncement}
            disabled={retryBlocked || isSubmitting}
            onComplete={handleVerifyComplete}
            onCancel={handleVerifyCancel}
          />
        )}
        {pendingAuth.verifyMethod === "pattern" && (
          <PatternLock
            mode="verify"
            error={promptError}
            errorAnnouncement={retryAnnouncement}
            disabled={retryBlocked || isSubmitting}
            onComplete={handleVerifyComplete}
            onCancel={handleVerifyCancel}
          />
        )}
        {pendingAuth.verifyMethod === "code" && (
          <div className="flex flex-col items-center w-full max-w-xs mx-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-2">輸入驗證碼</h2>
            <p className="text-sm text-gray-500 mb-4 text-center">
              請在電腦版 Extension 查看驗證碼
            </p>
            <ErrorAlert
              message={promptError}
              announcement={retryAnnouncement}
              className="mb-3"
            />
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ""))}
              placeholder="6 位數驗證碼"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-2xl tracking-widest focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none mb-4"
            />
            <button
              type="button"
              onClick={() => handleVerifyComplete(codeInput)}
              disabled={codeInput.length !== 6 || isSubmitting || retryBlocked}
              className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "驗證中..." : "確認"}
            </button>
            <button
              type="button"
              onClick={handleVerifyCancel}
              className="mt-3 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              取消
            </button>
          </div>
        )}
      </div>
    );
  }

  const formError = retryMessage || generalError || externalError;

  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white">
      <img
        src={APP_ENV !== "prod" ? "/dev/icon.svg" : "/icon.svg"}
        alt="墨家書櫃"
        className="w-16 h-16 rounded-2xl mb-4"
      />
      <h1 className="text-3xl font-bold text-gray-900 mb-2 flex items-center gap-2">
        墨家書櫃
        {APP_ENV !== "prod" && (
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-full ${
              APP_ENV === "local"
                ? "bg-red-100 text-red-700 border border-red-300"
                : "bg-blue-100 text-blue-700 border border-blue-300"
            }`}
          >
            {APP_ENV === "local" ? "LOCAL" : "DEV"}
          </span>
        )}
      </h1>
      <p className="text-gray-500 mb-8 text-center">
        家庭共享書櫃 — 與家人分享你的讀墨藏書
      </p>

      <form onSubmit={handleSubmit} className="w-full space-y-4 mt-8">
        <ErrorAlert message={formError} announcement={retryAnnouncement} />

        <div>
          <label
            htmlFor="sync-code"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            同步碼
          </label>
          <div className="relative">
            <input
              id="sync-code"
              type={showCode ? "text" : "password"}
              autoComplete="off"
              value={syncCodeInput}
              onChange={(e) => {
                setSyncCodeInput(e.target.value);
                if (syncCodeError) setSyncCodeError("");
              }}
              onPaste={hostVerdict.settleOnNextChange}
              onBlur={hostVerdict.settleNow}
              placeholder="moo-xxxxxxxx-xxxxxxxxxxxx"
              aria-invalid={!!syncCodeError || undefined}
              aria-describedby={syncCodeError ? "sync-code-error" : undefined}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 pr-10 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
            />
            <button
              type="button"
              onClick={() => setShowCode(!showCode)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5"
              aria-label={showCode ? "隱藏同步碼" : "顯示同步碼"}
            >
              {showCode ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {syncCodeError && (
            <p id="sync-code-error" className="text-red-500 text-xs mt-1">
              {syncCodeError}
            </p>
          )}
        </div>

        {/* Covers both the typed code and an invite link's pre-filled one. */}
        <SyncCodeHostNote result={hostVerdict.result} />

        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            讀墨帳號 Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError("");
            }}
            placeholder="your@email.com"
            aria-invalid={!!emailError || undefined}
            aria-describedby={emailError ? "email-error" : undefined}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          />
          {emailError && (
            <p id="email-error" className="text-red-500 text-xs mt-1">
              {emailError}
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={rememberSyncCode}
            onChange={(e) => setRememberSyncCode(e.target.checked)}
            className="rounded border-gray-300"
          />
          記住同步碼
        </label>

        <button
          type="submit"
          disabled={isSubmitting || retryBlocked}
          aria-busy={isSubmitting || undefined}
          className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "處理中..." : "開始使用"}
        </button>
      </form>

      <p className="text-xs text-gray-400 mt-6 text-center">
        建議使用桌面版 Chrome 擴充功能掃描 QR Code，更快完成設定。
      </p>
      <p className="text-xs text-gray-300 mt-4 text-center">
        本程式為第三方開發，非 Readmoo 讀墨官方提供。
      </p>
    </div>
  );
}
