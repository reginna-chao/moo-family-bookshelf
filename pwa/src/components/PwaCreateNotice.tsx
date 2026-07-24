import { useState, useEffect } from "react";
import { namespacedKey } from "@/hooks/useAuth";

interface PwaCreateNoticeProps {
  userId: string;
  onDismiss: () => void;
}

/**
 * One-time notice shown after a user creates a new family in the PWA,
 * explaining that book scanning requires the desktop Extension.
 * Stores dismissal in localStorage so it only shows once.
 */
export function PwaCreateNotice({ userId, onDismiss }: PwaCreateNoticeProps) {
  const [visible, setVisible] = useState(false);
  const storageKey = namespacedKey(userId, "pwaNoticeShown");

  useEffect(() => {
    if (localStorage.getItem(storageKey) !== "1") {
      setVisible(true);
    }
  }, [storageKey]);

  const handleDismiss = () => {
    localStorage.setItem(storageKey, "1");
    setVisible(false);
    onDismiss();
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl mx-6 max-w-sm w-full p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-3">
          歡迎使用墨家書櫃
        </h2>
        <p className="text-sm text-gray-600 leading-relaxed mb-6">
          掃描書籍需要使用讀墨的網頁版搭配瀏覽器擴充功能，手機版僅供瀏覽家庭書櫃。
        </p>
        <button
          onClick={handleDismiss}
          className="w-full bg-blue-600 text-white rounded-lg py-2.5 font-medium hover:bg-blue-700 transition-colors"
        >
          確定
        </button>
      </div>
    </div>
  );
}
