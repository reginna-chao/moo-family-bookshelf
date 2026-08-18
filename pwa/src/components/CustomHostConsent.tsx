/**
 * Consent gate for a QR arrival whose sync code carries a custom `@host`.
 *
 * The QR auto-join path has two zero-interaction exits (a valid QR token, or an
 * account with no verification configured), so without this screen a scanned
 * code could adopt someone else's server — and persist it — with the user never
 * seeing the address. This is the disclosure point for those exits.
 *
 * Presentational only: the caller decides when to mount it and what happens on
 * either answer. The caller mounts it exclusively for a `valid` verdict; the
 * `invalid` one is refused outright upstream and never reaches a screen that
 * asks the user to agree to it.
 *
 * The address itself is rendered by `SyncCodeHostNote`, the same component the
 * form and the verification screen use — one source for what gets shown, so the
 * disclosed value cannot drift from the address the client would actually call.
 * It gets `variant="verify"` per that component's rule: no sync code is on
 * screen here (a QR arrival never typed one), so the `join` lead-in would point
 * at something the user cannot see.
 */

import type { SyncCodeApiHostResult } from "@/crypto/syncCode";
import { SyncCodeHostNote } from "@/components/SyncCodeHostNote";

export interface CustomHostConsentProps {
  /** Verdict for the sync code's `@host`; expected to be `kind: "valid"`. */
  result: SyncCodeApiHostResult;
  /** Proceed with the join against the disclosed address. */
  onConfirm: () => void;
  /** Abandon the automatic join and fall back to manual sync-code entry. */
  onCancel: () => void;
}

export function CustomHostConsent({
  result,
  onConfirm,
  onCancel,
}: CustomHostConsentProps) {
  return (
    <div
      data-testid="custom-host-consent"
      className="max-w-md mx-auto min-h-screen flex flex-col items-center justify-center px-6 bg-white"
    >
      <div className="flex flex-col items-center w-full max-w-xs mx-auto">
        <h2 className="text-lg font-bold text-gray-900 mb-3 text-center">
          ⚠️ 此邀請指向自訂伺服器
        </h2>
        <SyncCodeHostNote
          result={result}
          variant="verify"
          className="mb-3 w-full"
        />
        <p className="text-sm text-gray-600 leading-relaxed text-center mb-5">
          加入後，你的認證資訊與完整書單（包含未開放的書籍）都會傳送到這個伺服器。請確認你信任這個位址再繼續。
        </p>
        {/* Equal weight, refusal first — the same shape the Extension's
            endpoint-switch panel uses. This screen exists to create friction,
            so handing an unknown server the auth token and the full book list
            must not be the visually strongest default; the amber matches the
            warning note above rather than a reassuring primary blue. */}
        <div className="flex flex-col w-full gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="w-full border border-gray-300 text-gray-700 rounded-lg py-3 font-medium hover:bg-gray-50 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="w-full bg-amber-700 text-white rounded-lg py-3 font-medium hover:bg-amber-800 transition-colors"
          >
            確認並加入
          </button>
        </div>
      </div>
    </div>
  );
}
