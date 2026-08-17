/**
 * Confirmation panel for a pending family API-endpoint switch.
 *
 * Presentational only — the decision logic lives in useEndpointSwitch. Styled
 * after the MemberList endpoint warning (amber panel + monospace endpoint box)
 * so both endpoint warnings read as one family of UI.
 *
 * Renders nothing when there is neither a pending switch nor a refusal notice,
 * so the caller can mount it unconditionally (same shape as VersionWarning).
 *
 * A target the client's validation would REFUSE is never printed: showing
 * `https://bank.example@evil.com` under 「將切換至」 dresses a spoofed address up
 * as a legitimate destination. The buttons stay live — confirming still fails
 * closed into the refusal notice below — only the address is withheld.
 */

import type { PendingEndpointSwitch } from "./useEndpointSwitch";

/** Label above the target address; an unusable target is not a destination. */
function buildTargetLabel(pending: PendingEndpointSwitch): string {
  if (!pending.targetValid) return "家庭指定的位址";
  if (pending.isDefaultTarget) return "將切換至（官方預設端點）";
  return "將切換至";
}

/**
 * Panel title. 「已變更」 only holds for the adopt-a-custom-endpoint direction:
 * the revert direction also fires when the family record NEVER carried an
 * endpoint — a LAN self-hoster's record cannot hold one at all (the Worker
 * rejects private addresses, see shared/src/api/endpointUrl.ts), so every
 * member would be told something changed when nothing ever did. State the
 * record's condition instead, which is true whether the owner cleared it or it
 * was never populated.
 */
function buildTitle(pending: PendingEndpointSwitch): string {
  if (pending.isDefaultTarget) return "⚠️ 家庭未指定 API 端點";
  return "⚠️ 家庭 API 端點已變更";
}

export interface EndpointSwitchPanelProps {
  /** The switch awaiting a decision; `null` when there is nothing to ask. */
  pending: PendingEndpointSwitch | null;
  /** True when the last confirmation was refused by the client's validation. */
  confirmError: boolean;
  onConfirm: () => void;
  onDecline: () => void;
  onDismissConfirmError: () => void;
}

export function EndpointSwitchPanel({
  pending,
  confirmError,
  onConfirm,
  onDecline,
  onDismissConfirmError,
}: EndpointSwitchPanelProps) {
  // Takes precedence over `pending`: the two are mutually exclusive in practice
  // (a fresh question clears the notice), and an unreported failed switch is
  // the more urgent thing to say.
  if (confirmError) {
    return (
      <div
        role="alert"
        data-testid="endpoint-switch-error"
        className="moo-endpoint-switch moo-endpoint-switch--error"
      >
        {/* JSX collapses this wrap into one space: "…私人網路的 HTTP），…". */}
        <div className="moo-endpoint-switch__error-text">
          此位址無法使用（需為 HTTPS，或本機／私人網路的
          HTTP），已略過此次切換。
        </div>
        <button
          onClick={onDismissConfirmError}
          className="moo-button moo-button--ghost moo-button--sm moo-endpoint-switch__error-dismiss"
        >
          知道了
        </button>
      </div>
    );
  }

  if (!pending) return null;

  const targetLabel = buildTargetLabel(pending);
  const title = buildTitle(pending);

  return (
    <div
      role="alert"
      className="moo-endpoint-switch"
      data-testid="endpoint-switch"
    >
      <div className="moo-endpoint-switch__title">{title}</div>
      <div className="moo-endpoint-switch__label">目前連線</div>
      <div className="moo-endpoint-switch__endpoint">{pending.current}</div>
      <div className="moo-endpoint-switch__label">{targetLabel}</div>
      {pending.targetValid && (
        <div className="moo-endpoint-switch__endpoint">
          {pending.targetEndpoint}
        </div>
      )}
      {!pending.targetValid && (
        <div
          className="moo-endpoint-switch__endpoint moo-endpoint-switch__endpoint--invalid"
          data-testid="endpoint-switch-invalid-target"
        >
          ⚠️ 此位址無效或不安全，無法切換，請向家庭管理者確認
        </div>
      )}
      <div className="moo-endpoint-switch__body">
        切換後，你的認證資訊與完整書單（包含未開放的書籍）都會傳送到新的伺服器。請確認你信任這個位址再切換。
      </div>
      <div className="moo-endpoint-switch__row">
        <button
          onClick={onDecline}
          className="moo-button moo-button--ghost moo-button--sm moo-endpoint-switch__decline"
        >
          暫不切換
        </button>
        <button
          onClick={onConfirm}
          className="moo-button moo-button--danger moo-button--sm moo-endpoint-switch__confirm"
        >
          確認切換
        </button>
      </div>
      <div className="moo-endpoint-switch__hint">
        選擇「暫不切換」後會保持目前的連線，除非家庭端點再次變更，否則不會再詢問。
      </div>
    </div>
  );
}
