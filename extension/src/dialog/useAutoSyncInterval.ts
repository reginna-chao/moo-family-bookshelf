import { useCallback } from "react";
import {
  DEFAULT_AUTO_SYNC_INTERVAL,
  type AutoSyncInterval,
} from "../storage/autoSyncInterval";
import { useAccountSetting } from "./useAccountSetting";

export type { AutoSyncInterval };

export interface UseAutoSyncIntervalReturn {
  interval: AutoSyncInterval;
  setInterval: (interval: AutoSyncInterval) => void;
  /** Text under the selector; `""` when there is nothing to report. */
  message: string;
}

/** The 自動同步頻率 selector, an account setting (#460); picking the current value sends nothing. */
export function useAutoSyncInterval(): UseAutoSyncIntervalReturn {
  const { value, message, change } = useAccountSetting(
    "autoSyncInterval",
    DEFAULT_AUTO_SYNC_INTERVAL,
  );

  const setInterval = useCallback(
    (next: AutoSyncInterval) => {
      void change(next);
    },
    [change],
  );

  return { interval: value, setInterval, message };
}
