import type { ApiClient } from "@/api/client";
import { CurrentSecretStep } from "@/components/CurrentSecretStep";
import { useTransferOwnership } from "@/hooks/useTransferOwnership";

interface MemberTransferConfirmProps {
  familyId: string;
  userId: string;
  targetId: string;
  /** The target's display label, as MemberList shows it. */
  label: string;
  apiClient: ApiClient;
  onStart: () => void;
  onTransferred: () => void;
  onFailed: (message: string) => void;
  onCancel: () => void;
}

/** MemberList's in-row 轉移管理權 confirm, then the current-secret entry for a PIN / pattern account. */
export function MemberTransferConfirm({
  familyId,
  userId,
  targetId,
  label,
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
      <div className="mt-2 rounded p-2 bg-blue-50">
        <CurrentSecretStep
          key={flow.secretAttempt}
          method={flow.secretMethod}
          purpose="transfer"
          onComplete={(secret) => void flow.submitSecret(secret)}
          error={flow.secretError}
          disabled={flow.loading}
          onCancel={cancel}
        />
      </div>
    );
  }

  return (
    <div className="mt-2 rounded p-2 bg-blue-50">
      <p className="text-xs mb-2 text-blue-700">
        {`確定要將管理權轉移給 ${label}？轉移後你將無法移除其他成員。`}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => void flow.start()}
          disabled={flow.loading}
          className="text-xs text-white px-3 py-1 rounded disabled:opacity-50 bg-blue-600 hover:bg-blue-700"
        >
          {flow.loading ? "處理中..." : "確定"}
        </button>
        <button
          onClick={cancel}
          disabled={flow.loading}
          className="text-xs bg-gray-200 text-gray-700 px-3 py-1 rounded hover:bg-gray-300 disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </div>
  );
}
