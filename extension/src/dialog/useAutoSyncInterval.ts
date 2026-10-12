import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_AUTO_SYNC_INTERVAL,
  readAutoSyncInterval,
  writeAutoSyncInterval,
  type AutoSyncInterval,
} from "../storage/autoSyncInterval";

export type { AutoSyncInterval };

export interface UseAutoSyncIntervalReturn {
  interval: AutoSyncInterval;
  setInterval: (interval: AutoSyncInterval) => void;
}

export function useAutoSyncInterval(): UseAutoSyncIntervalReturn {
  const [interval, setIntervalState] = useState<AutoSyncInterval>(
    DEFAULT_AUTO_SYNC_INTERVAL,
  );
  // Set once the user picks a value, so a mount read that resolves later cannot overwrite it.
  const userChoseRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await readAutoSyncInterval();
        if (!cancelled && !userChoseRef.current) {
          setIntervalState(stored);
        }
      } catch {
        // storage.local unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateInterval = useCallback(
    (next: AutoSyncInterval) => {
      if (interval === next) return;
      userChoseRef.current = true;
      setIntervalState(next);
      // Fire-and-forget, no rollback: direct storage.local writes are reliable here, and losing the
      // persistence beats snapping the choice back under the user.
      void writeAutoSyncInterval(next).catch(() => {
        // Ignore write failures; UI state remains authoritative.
      });
    },
    [interval],
  );

  return { interval, setInterval: updateInterval };
}
