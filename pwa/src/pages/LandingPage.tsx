import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import type { AuthState } from "@/hooks/useAuth";
import { useLandingFormFields } from "@/hooks/useLandingFormFields";
import { useLandingJoin } from "@/hooks/useLandingJoin";
import { useLandingSubmit } from "@/hooks/useLandingSubmit";
import { CustomHostConsent } from "@/components/CustomHostConsent";
import { LandingVerifyScreen } from "@/components/LandingVerifyScreen";
import { LandingBrandHeader } from "@/components/LandingBrandHeader";
import { LandingForm } from "@/components/LandingForm";

interface LandingPageProps {
  onAuth: (data: AuthState) => void;
  /** Pre-filled sync code from QR code, invite link, or remembered logout. */
  initialSyncCode?: string;
  /** Pre-hashed userId from QR code. Skips email entry and auto-triggers login. */
  qrUserId?: string;
  /** Short-lived QR token from Extension. Bypasses verification when valid. */
  qrToken?: string;
  /** External error (e.g., FAMILY_FULL / MEMBER_REMOVED from token refresh). */
  externalError?: string;
}

/**
 * The PWA sign-in page. Every piece of state lives in the hooks called here —
 * this component is always mounted while signed out — and the screens below
 * only render it: custom-host consent, verification, QR busy, or the form.
 */
export function LandingPage({
  onAuth,
  initialSyncCode = "",
  qrUserId = "",
  qrToken = "",
  externalError = "",
}: LandingPageProps) {
  const {
    syncCodeInput,
    setSyncCodeInput,
    hostVerdict,
    showCode,
    setShowCode,
    email,
    setEmail,
    rememberSyncCode,
    setRememberSyncCode,
    syncCodeError,
    setSyncCodeError,
    emailError,
    setEmailError,
  } = useLandingFormFields(initialSyncCode);

  const {
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
    retryMessage,
    retryAnnouncement,
    retryBlocked,
    clearRetryLock,
    completeJoin,
    handleVerifyComplete,
    handleVerifyCancel,
    hostConsent,
    handleHostConsentConfirm,
    handleHostConsentCancel,
  } = useLandingJoin({ onAuth, initialSyncCode, qrUserId, qrToken });

  const handleSubmit = useLandingSubmit({
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
  });

  // Back-off copy wins over the per-attempt error: it carries the live
  // countdown. `generalError` is last so non-verification failures (a 429 with
  // no retryAfter, NOT_FOUND, …) stay visible while the challenge UI is open.
  const promptError = retryMessage || verifyError || generalError;

  // Ordered ahead of the verification screen on purpose: consent is what
  // unblocks the request that could produce a challenge, so the two can never
  // legitimately be pending at once.
  if (hostConsent) {
    return (
      <CustomHostConsent
        result={classifySyncCodeApiHost(hostConsent.apiHost)}
        onConfirm={handleHostConsentConfirm}
        onCancel={handleHostConsentCancel}
      />
    );
  }

  // Show verification UI
  if (pendingAuth) {
    return (
      <div className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white">
        <LandingVerifyScreen
          apiHost={pendingAuth.apiHost}
          verifyMethod={pendingAuth.verifyMethod}
          promptError={promptError}
          retryAnnouncement={retryAnnouncement}
          retryBlocked={retryBlocked}
          isSubmitting={isSubmitting}
          codeInput={codeInput}
          setCodeInput={setCodeInput}
          onVerifyComplete={handleVerifyComplete}
          onVerifyCancel={handleVerifyCancel}
        />
      </div>
    );
  }

  // A QR arrival is auto-advanced past the form, so while its join runs there is
  // no submit button to carry a "處理中..." label — showing the form here would
  // ask a user who just scanned (or just pressed 確認並加入) to type an email.
  // The whole screen becomes the progress indicator instead. Ordered AFTER
  // `pendingAuth` on purpose: a challenge raised mid-join must stay on screen.
  if (joinOrigin === "qr") {
    return (
      <div
        data-testid="qr-join-busy"
        className="max-w-md mx-auto min-h-screen flex items-center justify-center"
      >
        <p className="text-gray-500">處理中...</p>
      </div>
    );
  }

  const formError = retryMessage || generalError || externalError;

  return (
    <div className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white">
      <LandingBrandHeader />

      <LandingForm
        onSubmit={handleSubmit}
        formError={formError}
        retryAnnouncement={retryAnnouncement}
        syncCodeInput={syncCodeInput}
        setSyncCodeInput={setSyncCodeInput}
        syncCodeError={syncCodeError}
        setSyncCodeError={setSyncCodeError}
        showCode={showCode}
        setShowCode={setShowCode}
        hostVerdict={hostVerdict}
        email={email}
        setEmail={setEmail}
        emailError={emailError}
        setEmailError={setEmailError}
        rememberSyncCode={rememberSyncCode}
        setRememberSyncCode={setRememberSyncCode}
        isSubmitting={isSubmitting}
        retryBlocked={retryBlocked}
      />

      <p className="text-xs text-gray-400 mt-6 text-center">
        建議使用桌面版 Chrome 擴充功能掃描 QR Code，更快完成設定。
      </p>
      <p className="text-xs text-gray-300 mt-4 text-center">
        本程式為第三方開發，非 Readmoo 讀墨官方提供。
      </p>
    </div>
  );
}
