import type { ApiClient } from "@/api/client";
import { useDeleteAccount } from "@/hooks/useDeleteAccount";

interface SettingsDeleteAccountSectionProps {
  userId: string;
  apiClient: ApiClient;
  onForceLogout: () => void;
}

/** 設定頁「移除帳戶」: idle → confirming (with the consequences) → deleting. */
export function SettingsDeleteAccountSection({
  userId,
  apiClient,
  onForceLogout,
}: SettingsDeleteAccountSectionProps) {
  const {
    deleteState,
    setDeleteState,
    deleteError,
    setDeleteError,
    handleDeleteAccount,
  } = useDeleteAccount({ userId, apiClient, onForceLogout });

  return (
    <section className="mb-6 mt-4">
      {deleteError && (
        <p role="alert" className="text-red-500 text-sm mb-2">
          {deleteError}
        </p>
      )}
      {deleteState === "idle" && (
        <button
          onClick={() => setDeleteState("confirming")}
          className="w-full rounded-lg border border-red-300 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
        >
          移除帳戶
        </button>
      )}
      {deleteState === "confirming" && (
        <div>
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
            <p className="text-sm font-bold text-red-700 mb-2">
              確定要移除帳戶嗎？
            </p>
            <ul className="text-xs text-red-600 list-disc list-inside space-y-1">
              <li>將移除墨家書櫃中的所有資料</li>
              <li>不影響你的讀墨帳號及書籍</li>
              <li>下次登入時將重新設定</li>
            </ul>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void handleDeleteAccount()}
              className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              確定移除
            </button>
            <button
              onClick={() => {
                setDeleteState("idle");
                setDeleteError(null);
              }}
              className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
      {deleteState === "deleting" && (
        <button
          disabled
          className="w-full rounded-lg bg-red-400 py-2.5 text-sm font-medium text-white opacity-50 cursor-not-allowed"
        >
          移除中...
        </button>
      )}
    </section>
  );
}
