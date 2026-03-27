import { useState } from "react";
import { decodeSyncCode, SyncCodeError } from "@/crypto/syncCode";
import { sha256Hex } from "@/crypto/encrypt";
import type { AuthState } from "@/hooks/useAuth";

interface LandingPageProps {
  onAuth: (data: AuthState) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LandingPage({ onAuth }: LandingPageProps) {
  const [syncCode, setSyncCode] = useState("");
  const [email, setEmail] = useState("");
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
      const userId = await sha256Hex(trimmedEmail);
      onAuth({
        userId,
        familyId: decoded.familyId,
        encryptionKey: decoded.encryptionKey,
        apiHost: decoded.apiHost,
      });
    } catch {
      setGeneralError("處理失敗，請重試。");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">牧家書櫃</h1>
      <p className="text-gray-500 mb-8 text-center">
        家庭共享書櫃 — 與家人分享你的讀墨藏書
      </p>

      <form onSubmit={handleSubmit} className="w-full space-y-4 mt-8">
        {generalError && (
          <p role="alert" className="text-red-500 text-sm text-center">
            {generalError}
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
    </div>
  );
}
