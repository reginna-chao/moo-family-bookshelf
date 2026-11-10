import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import type { ApiClient } from "@/api/client";
import { CurrentSecretStep } from "@/components/CurrentSecretStep";
import { useLeaveFamily } from "@/hooks/useLeaveFamily";

interface SettingsLeaveFamilySectionProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLogout: () => void;
}

/** Settings-page 「離開家庭」: idle → confirming → leaving. */
export function SettingsLeaveFamilySection({
  familyId,
  userId,
  apiClient,
  onLogout,
}: SettingsLeaveFamilySectionProps) {
  const {
    leaveState,
    setLeaveState,
    leaveError,
    setLeaveError,
    requiredMethod,
    secretError,
    startConfirming,
    handleLeave,
  } = useLeaveFamily({ familyId, userId, apiClient, onLogout });
  // A PIN / pattern account confirms with its current secret: the entry's own 確認 submits.
  const secretMethod =
    requiredMethod !== null && requiresCurrentSecret(requiredMethod)
      ? requiredMethod
      : null;
  const cancel = () => {
    setLeaveState("idle");
    setLeaveError(null);
  };

  return (
    <section className="mb-6">
      {leaveError && (
        <p role="alert" className="text-red-500 text-sm mb-2">
          {leaveError}
        </p>
      )}
      {leaveState === "idle" && (
        <button
          onClick={() => void startConfirming()}
          className="w-full rounded-lg border border-orange-300 py-2.5 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors"
        >
          離開家庭
        </button>
      )}
      {leaveState === "confirming" && secretMethod !== null && (
        <CurrentSecretStep
          method={secretMethod}
          purpose="leave"
          onComplete={(secret) => void handleLeave(secret)}
          error={secretError}
          onCancel={cancel}
        />
      )}
      {leaveState === "confirming" && secretMethod === null && (
        <div className="flex gap-2">
          <button
            onClick={() => void handleLeave()}
            className="flex-1 rounded-lg bg-orange-600 py-2.5 text-sm font-medium text-white hover:bg-orange-700 transition-colors"
          >
            確定離開
          </button>
          <button
            onClick={cancel}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
          >
            取消
          </button>
        </div>
      )}
      {leaveState === "leaving" && (
        <button
          disabled
          className="w-full rounded-lg bg-orange-400 py-2.5 text-sm font-medium text-white opacity-50 cursor-not-allowed"
        >
          離開中...
        </button>
      )}
    </section>
  );
}
