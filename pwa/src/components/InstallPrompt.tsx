import { useState, useEffect, useCallback, useRef } from "react";
import { namespacedKey } from "@/hooks/useAuth";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface InstallPromptProps {
  userId: string;
}

function isIosSafari(): boolean {
  // Feature-detect iOS: navigator.standalone only exists in iOS Safari
  const hasStandaloneProp = "standalone" in navigator;
  // Secondary signal: touch support via iOS-specific event
  const hasTouch = "ontouchend" in document;
  return hasStandaloneProp && hasTouch;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator &&
      (navigator as unknown as { standalone: boolean }).standalone === true)
  );
}

export function InstallPrompt({ userId }: InstallPromptProps) {
  const [visible, setVisible] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const dismissedKey = namespacedKey(userId, "installPromptDismissed");

  useEffect(() => {
    // Don't show if already installed or previously dismissed
    if (isStandalone()) return;
    if (localStorage.getItem(dismissedKey) === "1") return;

    if (isIosSafari()) {
      setIsIos(true);
      setVisible(true);
      return;
    }

    // Android/Chrome: listen for beforeinstallprompt
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, [dismissedKey]);

  const handleInstall = useCallback(async () => {
    const prompt = deferredPromptRef.current;
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") {
      setVisible(false);
    }
    deferredPromptRef.current = null;
  }, []);

  const handleDismiss = useCallback(() => {
    localStorage.setItem(dismissedKey, "1");
    setVisible(false);
  }, [dismissedKey]);

  if (!visible) return null;

  return (
    <div className="bg-blue-50 border-b border-blue-100 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          {isIos ? (
            <p className="text-sm text-blue-800">
              點選 Safari 底部的
              <span className="inline-block mx-1 align-middle">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="inline"
                >
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              </span>
              分享按鈕，然後選擇「加入主畫面」即可安裝。
            </p>
          ) : (
            <p className="text-sm text-blue-800">
              將墨家書櫃安裝到桌面，方便隨時使用。
            </p>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {!isIos && (
            <button
              onClick={() => void handleInstall()}
              className="px-3 py-1 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              安裝
            </button>
          )}
          <button
            onClick={handleDismiss}
            aria-label="關閉安裝提示"
            className="px-2 py-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
