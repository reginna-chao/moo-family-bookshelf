import { useState, useEffect, useCallback, useRef } from "react";
import { BoolFlag } from "../api/client";
import { readSyncArchived, writeSyncArchived } from "../storage/syncArchived";

export interface UseFamilySettingsSyncArchivedResult {
  syncArchived: number;
  handleToggleSyncArchived: () => void;
}

/**
 * The 同步封存書籍 switch: reads the flag from storage.local on mount and writes
 * each toggle straight back, keeping the user's choice on screen even if the write fails.
 */
export function useFamilySettingsSyncArchived(): UseFamilySettingsSyncArchivedResult {
  const [syncArchived, setSyncArchived] = useState<number>(BoolFlag.FALSE);
  // Set once the user toggles, so a mount read that resolves later cannot overwrite it.
  const userChoseRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await readSyncArchived();
        if (!cancelled && !userChoseRef.current) {
          setSyncArchived(stored);
        }
      } catch {
        // storage.local unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleSyncArchived = useCallback(() => {
    const next =
      syncArchived === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
    userChoseRef.current = true;
    setSyncArchived(next);
    // Fire-and-forget, no rollback: direct storage.local writes are reliable here, and losing the
    // persistence beats snapping the choice back under the user.
    void writeSyncArchived(next).catch(() => {
      // Ignore write failures; UI state remains authoritative.
    });
  }, [syncArchived]);

  return { syncArchived, handleToggleSyncArchived };
}
