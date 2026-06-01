import { useCallback, useEffect, useState } from "react";

export interface UseManualLendNoticeReturn {
  isDismissed: boolean;
  dismiss: () => void;
}

const STORAGE_KEY = "manualLendNoticeDismissed";

export function useManualLendNotice(): UseManualLendNoticeReturn {
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      if (cancelled) return;
      if (result[STORAGE_KEY] === true) {
        setIsDismissed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    void chrome.storage.local.set({ [STORAGE_KEY]: true });
    setIsDismissed(true);
  }, []);

  return { isDismissed, dismiss };
}
