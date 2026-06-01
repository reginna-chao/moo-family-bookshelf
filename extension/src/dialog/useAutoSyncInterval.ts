import { useCallback, useEffect, useRef, useState } from "react";
// Type-only import: avoids pulling the content scraper into the dialog bundle.
import type { AutoSyncInterval } from "../sync/syncBooks";

export type { AutoSyncInterval };

const DEFAULT_AUTO_SYNC_INTERVAL: AutoSyncInterval = "daily";

function isAutoSyncInterval(value: unknown): value is AutoSyncInterval {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "never";
}

export interface UseAutoSyncIntervalReturn {
  interval: AutoSyncInterval;
  setInterval: (interval: AutoSyncInterval) => void;
}

export function useAutoSyncInterval(): UseAutoSyncIntervalReturn {
  const [interval, setIntervalState] = useState<AutoSyncInterval>(DEFAULT_AUTO_SYNC_INTERVAL);
  const intervalRef = useRef(interval);

  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: "GET_AUTO_SYNC_INTERVAL" },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (isAutoSyncInterval(response?.interval)) {
          setIntervalState(response.interval);
        }
      },
    );
  }, []);

  const updateInterval = useCallback((next: AutoSyncInterval) => {
    const prev = intervalRef.current;
    if (prev === next) return;
    setIntervalState(next);
    chrome.runtime.sendMessage(
      { type: "SET_AUTO_SYNC_INTERVAL", interval: next },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setIntervalState(prev);
        }
      },
    );
  }, []);

  return { interval, setInterval: updateInterval };
}
