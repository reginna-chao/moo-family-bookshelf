import { useState } from "react";
import { REMEMBER_SYNC_CODE_KEY } from "@/hooks/useAuth";

interface SettingsLogoutSectionProps {
  onLogout: () => void;
}

/** 設定頁「登出」: a first press asks for confirmation, a second logs out. */
export function SettingsLogoutSection({
  onLogout,
}: SettingsLogoutSectionProps) {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  function handleLogout() {
    if (showLogoutConfirm) {
      onLogout();
    } else {
      setShowLogoutConfirm(true);
    }
  }

  return (
    <section className="pt-6 border-t border-gray-200">
      {showLogoutConfirm ? (
        <div>
          <p className="text-sm text-gray-600 mb-2">
            {localStorage.getItem(REMEMBER_SYNC_CODE_KEY) !== "0"
              ? "確定要登出嗎？同步碼已保留，下次登入免重新輸入。"
              : "確定要登出嗎？登出後需要重新輸入同步碼才能使用。"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleLogout}
              className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              確定登出
            </button>
            <button
              onClick={() => setShowLogoutConfirm(false)}
              className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={handleLogout}
          className="w-full rounded-lg border border-red-300 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
        >
          登出
        </button>
      )}
    </section>
  );
}
