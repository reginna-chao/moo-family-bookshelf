import { useState, useEffect, useRef } from "react";
import { decodeSyncCode, SyncCodeError } from "@/crypto/syncCode";
import { ApiClient } from "@/api/client";
import type { AuthState } from "@/hooks/useAuth";

interface LandingPageProps {
  onAuth: (data: AuthState) => void;
  apiClient: ApiClient;
  /** Pre-filled sync code from invite link (#family= URL param). */
  initialSyncCode?: string;
  /** External error (e.g., FAMILY_FULL from token refresh). */
  externalError?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LandingPage({ onAuth, apiClient, initialSyncCode = "", externalError = "" }: LandingPageProps) {
  const [syncCode, setSyncCode] = useState(initialSyncCode);
  const [email, setEmail] = useState("");

  // Cache join client per apiHost to avoid re-creating on each submit
  const joinClientRef = useRef<{ host: string | undefined; client: ApiClient } | null>(null);
  function getJoinClient(apiHost: string | undefined): ApiClient {
    if (joinClientRef.current !== null && joinClientRef.current.host === apiHost) {
      return joinClientRef.current.client;
    }
    const client = new ApiClient(apiHost);
    joinClientRef.current = { host: apiHost, client };
    return client;
  }

  // Update sync code if initialSyncCode changes (e.g., invite link loaded after mount)
  useEffect(() => {
    if (initialSyncCode) {
      setSyncCode(initialSyncCode);
    }
  }, [initialSyncCode]);
  const [syncCodeError, setSyncCodeError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [generalError, setGeneralError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSyncCodeError("");
    setEmailError("");
    setGeneralError("");

    // Validate sync code
    let decoded;
    try {
      decoded = decodeSyncCode(syncCode);
    } catch (err) {
      if (err instanceof SyncCodeError) {
        setSyncCodeError("同步碼格式不正確，請確認後重新輸入。");
      } else {
        setSyncCodeError("同步碼解析失敗，請重試。");
      }
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

    setIsSubmitting(true);

    try {
      const hashRes = await apiClient.hashEmail(trimmedEmail);
      if (hashRes.error) {
        setGeneralError("無法驗證帳號，請重試。");
        setIsSubmitting(false);
        return;
      }
      const userId = hashRes.data?.userId ?? "";

      // Join family before completing auth — blocks on FAMILY_FULL
      const joinClient = getJoinClient(decoded.apiHost);
      const joinRes = await joinClient.joinFamily(decoded.familyId, userId);
      if (joinRes.error) {
        if (joinRes.error.code === "FAMILY_FULL") {
          setGeneralError("家庭成員已達上限（每個家庭最多 2 位成員）");
        } else {
          setGeneralError(joinRes.error.message || "加入家庭失敗，請重試。");
        }
        setIsSubmitting(false);
        return;
      }

      // Extract auth token from join response
      const joinData = joinRes.data as unknown as { authToken?: string };

      onAuth({
        userId,
        familyId: decoded.familyId,
        encryptionKey: decoded.encryptionKey,
        apiHost: decoded.apiHost,
        authToken: joinData?.authToken,
      });
    } catch {
      setGeneralError("處理失敗，請重試。");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white">
      <img src="/icon.svg" alt="牧家書櫃" className="w-16 h-16 rounded-2xl mb-4" />
      <h1 className="text-3xl font-bold text-gray-900 mb-2">牧家書櫃</h1>
      <p className="text-gray-500 mb-8 text-center">
        家庭共享書櫃 — 與家人分享你的讀墨藏書
      </p>

      <form onSubmit={handleSubmit} className="w-full space-y-4 mt-8">
        {(generalError || externalError) && (
          <p role="alert" className="text-red-500 text-sm text-center">
            {generalError || externalError}
          </p>
        )}

        <div>
          <label
            htmlFor="sync-code"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            同步碼
          </label>
          <input
            id="sync-code"
            type="text"
            autoComplete="off"
            value={syncCode}
            onChange={(e) => {
              setSyncCode(e.target.value);
              if (syncCodeError) setSyncCodeError("");
            }}
            placeholder="moo-familyId-encryptionKey"
            aria-invalid={!!syncCodeError || undefined}
            aria-describedby={syncCodeError ? "sync-code-error" : undefined}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          />
          {syncCodeError && (
            <p id="sync-code-error" className="text-red-500 text-xs mt-1">
              {syncCodeError}
            </p>
          )}
        </div>

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

        <button
          type="submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting || undefined}
          className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "處理中..." : "開始使用"}
        </button>
      </form>

      <p className="text-xs text-gray-400 mt-6 text-center">
        建議使用桌面版 Chrome 擴充功能掃描 QR Code，更快完成設定。
      </p>
      <p className="text-[10px] text-gray-300 mt-4 text-center">
        本程式為第三方開發，非 Readmoo 讀墨官方提供。
      </p>
    </div>
  );
}
