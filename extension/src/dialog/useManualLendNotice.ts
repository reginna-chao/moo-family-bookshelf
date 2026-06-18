import { useCallback, useEffect, useState } from "react";
import browser from "webextension-polyfill";
import { MANUAL_LEND_NOTICE_DISMISSED_KEY } from "../constants";

export interface UseManualLendNoticeReturn {
  isDismissed: boolean;
  dismiss: () => void;
}

export function useManualLendNotice(): UseManualLendNoticeReturn {
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await browser.storage.local.get([
        MANUAL_LEND_NOTICE_DISMISSED_KEY,
      ]);
      if (cancelled) return;
      if (result[MANUAL_LEND_NOTICE_DISMISSED_KEY] === true) {
        setIsDismissed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    void browser.storage.local.set({ [MANUAL_LEND_NOTICE_DISMISSED_KEY]: true });
    setIsDismissed(true);
  }, []);

  return { isDismissed, dismiss };
}
