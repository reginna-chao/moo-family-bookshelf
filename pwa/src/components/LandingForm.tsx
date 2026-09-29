import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { UseSyncCodeHostVerdictResult } from "@/hooks/useSyncCodeHostVerdict";
import { ErrorAlert } from "@/components/ErrorAlert";
import { SyncCodeHostNote } from "@/components/SyncCodeHostNote";
import { LandingSyncCodeField } from "@/components/LandingSyncCodeField";
import { LandingEmailField } from "@/components/LandingEmailField";

interface LandingFormProps {
  onSubmit: (e: FormEvent) => Promise<void>;
  formError: string;
  retryAnnouncement: string | undefined;
  syncCodeInput: string;
  setSyncCodeInput: Dispatch<SetStateAction<string>>;
  syncCodeError: string;
  setSyncCodeError: Dispatch<SetStateAction<string>>;
  showCode: boolean;
  setShowCode: Dispatch<SetStateAction<boolean>>;
  hostVerdict: UseSyncCodeHostVerdictResult;
  email: string;
  setEmail: Dispatch<SetStateAction<string>>;
  emailError: string;
  setEmailError: Dispatch<SetStateAction<string>>;
  rememberSyncCode: boolean;
  setRememberSyncCode: Dispatch<SetStateAction<boolean>>;
  isSubmitting: boolean;
  retryBlocked: boolean;
}

/**
 * The manual sign-in form: sync code, its `@host` note, email, the remember
 * toggle and submit. Every value is owned by `LandingPage`; this only renders.
 */
export function LandingForm({
  onSubmit,
  formError,
  retryAnnouncement,
  syncCodeInput,
  setSyncCodeInput,
  syncCodeError,
  setSyncCodeError,
  showCode,
  setShowCode,
  hostVerdict,
  email,
  setEmail,
  emailError,
  setEmailError,
  rememberSyncCode,
  setRememberSyncCode,
  isSubmitting,
  retryBlocked,
}: LandingFormProps) {
  return (
    <form onSubmit={onSubmit} className="w-full space-y-4 mt-8">
      <ErrorAlert message={formError} announcement={retryAnnouncement} />

      <LandingSyncCodeField
        syncCodeInput={syncCodeInput}
        setSyncCodeInput={setSyncCodeInput}
        syncCodeError={syncCodeError}
        setSyncCodeError={setSyncCodeError}
        showCode={showCode}
        setShowCode={setShowCode}
        hostVerdict={hostVerdict}
      />

      {/* Covers both the typed code and an invite link's pre-filled one. */}
      <SyncCodeHostNote result={hostVerdict.result} />

      <LandingEmailField
        email={email}
        setEmail={setEmail}
        emailError={emailError}
        setEmailError={setEmailError}
      />

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
  );
}
