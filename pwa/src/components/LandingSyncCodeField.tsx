import type { Dispatch, SetStateAction } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { UseSyncCodeHostVerdictResult } from "@/hooks/useSyncCodeHostVerdict";

interface LandingSyncCodeFieldProps {
  syncCodeInput: string;
  setSyncCodeInput: Dispatch<SetStateAction<string>>;
  syncCodeError: string;
  setSyncCodeError: Dispatch<SetStateAction<string>>;
  showCode: boolean;
  setShowCode: Dispatch<SetStateAction<boolean>>;
  /** Settle triggers of the `@host` verdict (paste, blur). */
  hostVerdict: Pick<
    UseSyncCodeHostVerdictResult,
    "settleOnNextChange" | "settleNow"
  >;
}

/** The login form's masked sync-code input with its show/hide toggle. */
export function LandingSyncCodeField({
  syncCodeInput,
  setSyncCodeInput,
  syncCodeError,
  setSyncCodeError,
  showCode,
  setShowCode,
  hostVerdict,
}: LandingSyncCodeFieldProps) {
  return (
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
  );
}
