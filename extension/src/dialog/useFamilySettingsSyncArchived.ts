import { useState, useEffect, useCallback } from "react";
import browser from "webextension-polyfill";
import { BoolFlag } from "../api/client";

export interface UseFamilySettingsSyncArchivedResult {
  syncArchived: number;
  handleToggleSyncArchived: () => void;
}

/**
 * The 同步封存書籍 switch: reads the flag from the background on mount and
 * writes it back optimistically, reverting when the background refuses.
 */
export function useFamilySettingsSyncArchived(): UseFamilySettingsSyncArchivedResult {
  const [syncArchived, setSyncArchived] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GET_SYNC_ARCHIVED",
        })) as { syncArchived?: number } | undefined;
        if (cancelled) return;
        if (response?.syncArchived !== undefined) {
          setSyncArchived(response.syncArchived);
        }
      } catch {
        // Background unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleSyncArchived = useCallback(() => {
    const prev = syncArchived;
    const newValue = prev === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
    setSyncArchived(newValue);
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "SET_SYNC_ARCHIVED",
          syncArchived: newValue,
        })) as { ok?: boolean } | undefined;
        if (!response?.ok) {
          setSyncArchived(prev);
        }
      } catch {
        setSyncArchived(prev);
      }
    })();
  }, [syncArchived]);

  return { syncArchived, handleToggleSyncArchived };
}
