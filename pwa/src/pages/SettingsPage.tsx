import type { ApiClient } from "@/api/client";

interface SettingsPageProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLogout: () => void;
}

export function SettingsPage({
  familyId: _familyId,
  userId: _userId,
  apiClient: _apiClient,
  onLogout,
}: SettingsPageProps) {
  function handleLogout() {
    if (confirm("確定要登出嗎？登出後需要重新輸入同步碼才能使用。")) {
      onLogout();
    }
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-4">設定</h2>
      <p className="text-gray-500 text-sm">
        API 端點、家庭管理等設定將顯示在這裡。
      </p>

      <div className="mt-8 pt-6 border-t border-gray-200">
        <button
          onClick={handleLogout}
          className="w-full rounded-lg border border-red-300 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
        >
          登出
        </button>
      </div>
    </div>
  );
}
