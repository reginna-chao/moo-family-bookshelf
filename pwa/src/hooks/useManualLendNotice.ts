import { useCallback, useEffect, useState } from "react";
import { namespacedKey } from "@/hooks/useAuth";

export interface UseManualLendNoticeReturn {
  isDismissed: boolean;
  dismiss: () => void;
}

function readDismissed(storageKey: string): boolean {
  return localStorage.getItem(storageKey) === "true";
}

export function useManualLendNotice(userId: string): UseManualLendNoticeReturn {
  const storageKey = namespacedKey(userId, "manualLendNoticeDismissed");

  const [isDismissed, setIsDismissed] = useState<boolean>(() =>
    readDismissed(storageKey),
  );

  useEffect(() => {
    setIsDismissed(readDismissed(storageKey));
  }, [storageKey]);

  const dismiss = useCallback(() => {
    localStorage.setItem(storageKey, "true");
    setIsDismissed(true);
  }, [storageKey]);

  return { isDismissed, dismiss };
}
