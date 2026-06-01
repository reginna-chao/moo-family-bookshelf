/**
 * Hook for book sync in the dialog UI.
 * Provides:
 * - Auto-sync on dialog open when on #/library (rate limited >= 24 hours)
 * - Manual sync button handler (no rate limiting)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ApiClient, BookEntry } from "../api/client";
import { syncBooks, canAutoSync } from "../sync/syncBooks";
import { formatScrapeProgress } from "../content/scraper";

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
  /** Live progress message during a paginated scrape (Wave G). Empty otherwise. */
  progressMessage: string;
}

export function useBookSync({ userId, apiClient }: UseBookSyncOptions): UseBookSyncReturn {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSyncBooks, setLastSyncBooks] = useState<BookEntry[]>([]);
  const [autoSyncDone, setAutoSyncDone] = useState(false);
  const [progressMessage, setProgressMessage] = useState("");
  const autoSyncTriggered = useRef(false);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    };
  }, []);

  // Mechanism A: Auto-sync when dialog opens on #/library page
  useEffect(() => {
    if (autoSyncTriggered.current) return;
    autoSyncTriggered.current = true;

    const isOnLibrary = window.location.hash.includes("#/library");
    if (!isOnLibrary) return;

    canAutoSync().then(async (allowed) => {
      if (!allowed) return;

      setSyncStatus("syncing");
      setProgressMessage("");
      try {
        const result = await syncBooks({
          navigate: false,
          userId,
          apiClient,
          onProgress: (page, count) =>
            setProgressMessage(formatScrapeProgress(page, count)),
        });
        setProgressMessage("");
        if (result.success) {
          setLastSyncBooks(result.books);
          setSyncStatus("done");
          setAutoSyncDone(true);
          if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
          statusTimerRef.current = setTimeout(() => setSyncStatus("idle"), 2000);
        } else {
          setSyncError(result.error ?? "自動同步失敗");
          setSyncStatus("error");
        }
      } catch (err) {
        setProgressMessage("");
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
    setProgressMessage("");

    const result = await syncBooks({
      navigate: true,
      userId,
      apiClient,
      onProgress: (page, count) =>
        setProgressMessage(formatScrapeProgress(page, count)),
    });
    setProgressMessage("");
    if (result.success) {
      setLastSyncBooks(result.books);
      setSyncStatus("done");
      if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setSyncStatus("idle"), 2000);
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
    progressMessage,
  };
}
