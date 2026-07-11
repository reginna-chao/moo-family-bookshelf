/**
 * Hook for book sync in the dialog UI.
 * Provides:
 * - Auto-sync on personal-shelf mount (a full sync, rate limited by autoSyncInterval)
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
  /** Enables auto-return detection on sync (owner's returned books → RETURNED). */
  familyId?: string;
  /** Called after a sync that auto-returned ≥1 book, so the borrow list can refresh. */
  onAutoReturned?: () => void;
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

export function useBookSync({
  userId,
  apiClient,
  familyId,
  onAutoReturned,
}: UseBookSyncOptions): UseBookSyncReturn {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSyncBooks, setLastSyncBooks] = useState<BookEntry[]>([]);
  const [autoSyncDone, setAutoSyncDone] = useState(false);
  const [progressMessage, setProgressMessage] = useState("");
  const autoSyncTriggered = useRef(false);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest familyId + auto-return callback held in refs so the sync effect /
  // manual-sync callback can read them without widening their dependency arrays
  // (and without re-triggering the once-per-session auto sync).
  const familyIdRef = useRef(familyId);
  familyIdRef.current = familyId;
  const onAutoReturnedRef = useRef(onAutoReturned);
  onAutoReturnedRef.current = onAutoReturned;

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    };
  }, []);

  // Mechanism A: Auto full sync when the personal shelf mounts.
  // Throttled by canAutoSync() (LAST_SYNC_AT_KEY + autoSyncInterval); `never`
  // disables it. Uses navigate:true so it works regardless of the current hash
  // (syncBooks restores the original hash afterwards), matching manual sync.
  useEffect(() => {
    if (autoSyncTriggered.current) return;
    autoSyncTriggered.current = true;

    canAutoSync().then(async (allowed) => {
      if (!allowed) return;

      setSyncStatus("syncing");
      setProgressMessage("");
      try {
        const result = await syncBooks({
          navigate: true,
          userId,
          apiClient,
          familyId: familyIdRef.current,
          onProgress: (page, count) =>
            setProgressMessage(formatScrapeProgress(page, count)),
        });
        setProgressMessage("");
        if (result.success) {
          setLastSyncBooks(result.books);
          setSyncStatus("done");
          setAutoSyncDone(true);
          if (result.autoReturnedCount && result.autoReturnedCount > 0) {
            onAutoReturnedRef.current?.();
          }
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

  // Mechanism B: Manual sync (no rate limiting)
  const triggerManualSync = useCallback(async () => {
    setSyncStatus("syncing");
    setSyncError("");
    setProgressMessage("");

    const result = await syncBooks({
      navigate: true,
      userId,
      apiClient,
      familyId: familyIdRef.current,
      onProgress: (page, count) =>
        setProgressMessage(formatScrapeProgress(page, count)),
    });
    setProgressMessage("");
    if (result.success) {
      setLastSyncBooks(result.books);
      setSyncStatus("done");
      if (result.autoReturnedCount && result.autoReturnedCount > 0) {
        onAutoReturnedRef.current?.();
      }
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
