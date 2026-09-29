import type { Dispatch, SetStateAction } from "react";
import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import type { VerifyMethod } from "@/api/client";
import { PinInput } from "@/components/PinInput";
import { PatternLock } from "@/components/PatternLock";
import { ErrorAlert } from "@/components/ErrorAlert";
import { SyncCodeHostNote } from "@/components/SyncCodeHostNote";

interface LandingVerifyScreenProps {
  /** Server the pending join will authenticate to; undefined = default. */
  apiHost?: string;
  verifyMethod: VerifyMethod;
  promptError: string;
  retryAnnouncement: string | undefined;
  retryBlocked: boolean;
  isSubmitting: boolean;
  /** The typed one-time code (`code` method only); state stays in the page. */
  codeInput: string;
  setCodeInput: Dispatch<SetStateAction<string>>;
  onVerifyComplete: (secret: string) => void;
  onVerifyCancel: () => void;
}

/**
 * The verification challenge (PIN / pattern / one-time code) for a pending
 * join. Renders only the screen's CONTENTS: `LandingPage` keeps the wrapping
 * `<div>`, so the page root stays the same DOM node across screen switches.
 */
export function LandingVerifyScreen({
  apiHost,
  verifyMethod,
  promptError,
  retryAnnouncement,
  retryBlocked,
  isSubmitting,
  codeInput,
  setCodeInput,
  onVerifyComplete,
  onVerifyCancel,
}: LandingVerifyScreenProps) {
  return (
    <>
      {/* QR / invite arrivals never see the form, so this is their only
          chance to learn which server they are about to authenticate to. */}
      <SyncCodeHostNote
        result={classifySyncCodeApiHost(apiHost)}
        variant="verify"
        className="mb-4 w-full max-w-xs"
      />
      {verifyMethod === "pin" && (
        <PinInput
          mode="verify"
          error={promptError}
          errorAnnouncement={retryAnnouncement}
          disabled={retryBlocked || isSubmitting}
          onComplete={onVerifyComplete}
          onCancel={onVerifyCancel}
        />
      )}
      {verifyMethod === "pattern" && (
        <PatternLock
          mode="verify"
          error={promptError}
          errorAnnouncement={retryAnnouncement}
          disabled={retryBlocked || isSubmitting}
          onComplete={onVerifyComplete}
          onCancel={onVerifyCancel}
        />
      )}
      {verifyMethod === "code" && (
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
            onClick={() => onVerifyComplete(codeInput)}
            disabled={codeInput.length !== 6 || isSubmitting || retryBlocked}
            className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "驗證中..." : "確認"}
          </button>
          <button
            type="button"
            onClick={onVerifyCancel}
            className="mt-3 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            取消
          </button>
        </div>
      )}
    </>
  );
}
