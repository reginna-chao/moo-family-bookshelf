// Presentational panel for a family endpoint switch (logic: useEndpointSwitch); renders nothing when
// idle. A refused target is never printed: docs/architecture.md → 端點切換確認.

import type { PendingEndpointSwitch } from "./useEndpointSwitch";

/** Label above the target address; an unusable target is not a destination. */
function buildTargetLabel(pending: PendingEndpointSwitch): string {
  if (!pending.targetValid) return "家庭指定的位址";
  if (pending.isDefaultTarget) return "將切換至（官方預設端點）";
  return "將切換至";
}

/** 「已變更」 holds only when adopting a custom endpoint; the revert title states the record's
 *  condition (a LAN record never holds one). docs/architecture.md → 可設定 API 端點 → 限制. */
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
  // Wins over `pending` (exclusive in practice: a fresh question clears the notice); an unreported
  // failed switch is the more urgent thing to say.
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
