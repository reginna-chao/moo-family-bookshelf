import type { ApiClient } from "../api/client";
import { CurrentSecretStep } from "./CurrentSecretStep";
import {
  useTransferOwnership,
  type TransferAction,
  type UseTransferOwnershipResult,
} from "./useTransferOwnership";

export interface MemberTransferConfirmProps {
  familyId: string;
  userId: string;
  targetId: string;
  familyEndpoint?: string;
  apiClient: ApiClient;
  onStart: () => void;
  onTransferred: () => void;
  onFailed: (message: string) => void;
  onCancel: () => void;
}

interface TransferNoticeProps {
  notice: string;
}

function TransferNotice({ notice }: TransferNoticeProps) {
  if (!notice) return null;
  return <div className="moo-member-list__error">{notice}</div>;
}

interface PlainTransferConfirmProps {
  flow: UseTransferOwnershipResult;
  onCancel: () => void;
}

/** No custom endpoint: one 確定 button. */
function PlainTransferConfirm({ flow, onCancel }: PlainTransferConfirmProps) {
  return (
    <div className="moo-member-list__confirm">
      <div className="moo-member-list__confirm-text">
        確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。
      </div>
      <TransferNotice notice={flow.notice} />
      <div className="moo-member-list__confirm-row">
        <button
          disabled={flow.loading}
          onClick={() => void flow.start()}
          className="moo-button moo-button--danger moo-button--xs moo-member-list__confirm-yes"
        >
          {flow.loading ? "處理中..." : "確定"}
        </button>
        <button
          disabled={flow.loading}
          onClick={onCancel}
          className="moo-button moo-button--ghost moo-button--xs moo-member-list__confirm-no"
        >
          取消
        </button>
      </div>
    </div>
  );
}

interface EndpointTransferConfirmProps extends PlainTransferConfirmProps {
  familyEndpoint: string;
}

/** Custom endpoint: the new owner keeps it or it is cleared with the transfer. */
function EndpointTransferConfirm({
  flow,
  onCancel,
  familyEndpoint,
}: EndpointTransferConfirmProps) {
  const busy = (action: TransferAction) =>
    flow.loading && flow.activeAction === action;
  return (
    <div className="moo-member-list__confirm moo-member-list__confirm--warn">
      <div className="moo-member-list__confirm-warn-title">
        ⚠️ 目前家庭使用自訂 API 端點
      </div>
      <div className="moo-member-list__endpoint">{familyEndpoint}</div>
      <div className="moo-member-list__confirm-warn-body">
        轉移擁有者後，只有新擁有者可以變更或清除此設定。
      </div>
      <ul className="moo-member-list__confirm-warn-list">
        <li>清除：回復為預設端點（家庭資料將需要重建）</li>
        <li>不清除：新擁有者繼承目前的端點設定</li>
      </ul>
      <TransferNotice notice={flow.notice} />
      <div className="moo-member-list__confirm-row moo-member-list__confirm-row--end">
        <button
          disabled={flow.loading}
          onClick={onCancel}
          className="moo-button moo-button--ghost moo-member-list__endpoint-cancel"
        >
          取消
        </button>
        <button
          disabled={flow.loading}
          onClick={() => void flow.start(undefined, "keep")}
          className="moo-button moo-button--outline moo-button--sm moo-member-list__endpoint-keep"
        >
          {busy("keep") ? "處理中..." : "不清除，直接轉移"}
        </button>
        <button
          disabled={flow.loading}
          onClick={() => void flow.start(1, "clear")}
          className="moo-button moo-button--sm moo-member-list__endpoint-clear"
        >
          {busy("clear") ? "處理中..." : "清除並轉移"}
        </button>
      </div>
    </div>
  );
}

/**
 * MemberList's 轉移管理權 confirm: the confirm screen, then — for a PIN /
 * pattern account — the current-secret entry, rendered in the secure frame.
 */
export function MemberTransferConfirm({
  familyId,
  userId,
  targetId,
  familyEndpoint,
  apiClient,
  onStart,
  onTransferred,
  onFailed,
  onCancel,
}: MemberTransferConfirmProps) {
  const flow = useTransferOwnership({
    familyId,
    userId,
    targetId,
    apiClient,
    onStart,
    onTransferred,
    onFailed,
  });
  const cancel = () => {
    flow.reset();
    onCancel();
  };

  if (flow.secretMethod !== null) {
    return (
      <div className="moo-member-list__confirm">
        <CurrentSecretStep
          key={flow.secretAttempt}
          method={flow.secretMethod}
          purpose="transfer"
          onComplete={(secret) => void flow.submitSecret(secret)}
          error={flow.secretError}
          disabled={flow.loading}
          autoFocus={flow.secretAttempt > 0}
        />
        <div className="moo-member-list__confirm-row">
          <button
            disabled={flow.loading}
            onClick={cancel}
            className="moo-button moo-button--ghost moo-button--xs moo-member-list__confirm-no"
          >
            取消
          </button>
        </div>
      </div>
    );
  }
  if (familyEndpoint) {
    return (
      <EndpointTransferConfirm
        flow={flow}
        onCancel={cancel}
        familyEndpoint={familyEndpoint}
      />
    );
  }
  return <PlainTransferConfirm flow={flow} onCancel={cancel} />;
}
