/**
 * Hook for book sync in the dialog UI.
 * Provides:
 * - Auto-sync on dialog open when on #/library (rate limited >= 1 hour)
 * - Manual sync button handler (no rate limiting)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient, BookEntry } from "../api/client";
import { syncBooks, canAutoSync } from "../sync/syncBooks";

export type SyncStatus = "idle" | "syncing" | "done" | "error";

export interface UseBookSyncOptions {
  userId: string;
  apiClient: ApiClient;
}

export interface UseBookSyncReturn {
  syncStatus: SyncStatus;
  syncError: string;
  lastSyncBooks: BookEntry[];
  /** Trigger a manual sync (no rate limit) */
  triggerManualSync: () => Promise<void>;
  /** Whether auto-sync happened this session */
  autoSyncDone: boolean;
}

export function useBookSync({ userId, apiClient }: UseBookSyncOptions): UseBookSyncReturn {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSyncBooks, setLastSyncBooks] = useState<BookEntry[]>([]);
  const [autoSyncDone, setAutoSyncDone] = useState(false);
  const autoSyncTriggered = useRef(false);

  // Mechanism A: Auto-sync when dialog opens on #/library page
  useEffect(() => {
    if (autoSyncTriggered.current) return;
    autoSyncTriggered.current = true;

    const isOnLibrary = window.location.hash.includes("#/library");
    if (!isOnLibrary) return;

    canAutoSync().then(async (allowed) => {
      if (!allowed) return;

      setSyncStatus("syncing");
      try {
        const result = await syncBooks({ navigate: false, userId, apiClient });
        if (result.success) {
          setLastSyncBooks(result.books);
          setSyncStatus("done");
          setAutoSyncDone(true);
          setTimeout(() => setSyncStatus("idle"), 2000);
        } else {
          setSyncError(result.error ?? "自動同步失敗");
          setSyncStatus("error");
        }
      } catch (err) {
        setSyncError(err instanceof Error ? err.message : "自動同步失敗");
        setSyncStatus("error");
      }
    }).catch((err) => {
      console.warn("[useBookSync] canAutoSync check failed:", err);
    });
  }, [userId, apiClient]);

  // Mechanism C: Manual sync (no rate limiting)
  const triggerManualSync = useCallback(async () => {
    setSyncStatus("syncing");
    setSyncError("");

    const result = await syncBooks({ navigate: true, userId, apiClient });
    if (result.success) {
      setLastSyncBooks(result.books);
      setSyncStatus("done");
      setTimeout(() => setSyncStatus("idle"), 2000);
    } else {
      setSyncError(result.error ?? "同步失敗");
      setSyncStatus("error");
    }
  }, [userId, apiClient]);

  return {
    syncStatus,
    syncError,
    lastSyncBooks,
    triggerManualSync,
    autoSyncDone,
  };
}
