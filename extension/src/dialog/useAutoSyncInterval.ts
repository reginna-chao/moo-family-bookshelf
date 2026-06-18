import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
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
    let cancelled = false;
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GET_AUTO_SYNC_INTERVAL",
        })) as { interval?: unknown } | undefined;
        if (cancelled) return;
        if (isAutoSyncInterval(response?.interval)) {
          setIntervalState(response.interval);
        }
      } catch {
        // Background unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateInterval = useCallback((next: AutoSyncInterval) => {
    const prev = intervalRef.current;
    if (prev === next) return;
    setIntervalState(next);
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "SET_AUTO_SYNC_INTERVAL",
          interval: next,
        })) as { ok?: boolean } | undefined;
        if (!response?.ok) {
          setIntervalState(prev);
        }
      } catch {
        setIntervalState(prev);
      }
    })();
  }, []);

  return { interval, setInterval: updateInterval };
}
