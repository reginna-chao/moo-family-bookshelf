/**
 * Hook for book sync in the dialog UI.
 * Provides:
 * - Auto-sync on personal-shelf mount (a full sync, rate limited by autoSyncInterval)
 * - Manual sync button handler (no rate limiting)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ApiClient, BookEntry } from "../api/client";
import {
  syncBooks,
  canAutoSync,
  type SyncBooksResult,
} from "../sync/syncBooks";
import type { RenamedBook } from "../sync/renamedBooks";
import { formatScrapeProgress } from "../content/scraper";

export type SyncStatus = "idle" | "syncing" | "done" | "error";

/** The last SUCCESSFUL sync, held as one value so its parts never mismatch. */
interface LastSync {
  books: BookEntry[];
  renamedBooks: RenamedBook[];
  renamedBookCount: number;
  /** The `lastUpdated` this sync's own PUT stored; undefined when the PUT response carries none. */
  lastUpdated?: string;
}

const NO_SYNC: LastSync = { books: [], renamedBooks: [], renamedBookCount: 0 };

function lastSyncOf(result: SyncBooksResult): LastSync {
  const renamedBooks = result.renamedBooks ?? [];
  return {
    books: result.books,
    renamedBooks,
    renamedBookCount: result.renamedBookCount ?? renamedBooks.length,
    lastUpdated: result.lastUpdated,
  };
}

export interface UseBookSyncOptions {
  userId: string;
  apiClient: ApiClient;
  /** Enables auto-return detection on sync (owner's returned books → RETURNED). */
  familyId?: string;
  /** Called with the auto-returned requestIds after a sync returned ≥1 book. */
  onAutoReturned?: (requestIds: string[]) => void;
}

export interface UseBookSyncReturn {
  syncStatus: SyncStatus;
  syncError: string;
  lastSyncBooks: BookEntry[];
  /**
   * Books the last SUCCESSFUL sync moved to their new Readmoo id. Always from
   * the same sync as `lastSyncBooks` (both change in the same render).
   */
  lastSyncRenamedBooks: RenamedBook[];
  /** The `lastUpdated` that same sync's PUT stored; undefined before a sync or when its PUT response carries none. */
  lastSyncLastUpdated: string | undefined;
  /** Trigger a manual sync (no rate limit) */
  triggerManualSync: () => Promise<void>;
  /** Whether auto-sync happened this session */
  autoSyncDone: boolean;
  /** Live progress message during a paginated scrape (Wave G). Empty otherwise. */
  progressMessage: string;
  /** Books moved to their new Readmoo id by the last SUCCESSFUL sync (0 = none). */
  renamedBookCount: number;
}

export function useBookSync({
  userId,
  apiClient,
  familyId,
  onAutoReturned,
}: UseBookSyncOptions): UseBookSyncReturn {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSync, setLastSync] = useState<LastSync>(NO_SYNC);
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

    canAutoSync()
      .then(async (allowed) => {
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
            setLastSync(lastSyncOf(result));
            setSyncStatus("done");
            setAutoSyncDone(true);
            const returnedIds = result.autoReturnedRequestIds;
            if (returnedIds && returnedIds.length > 0) {
              onAutoReturnedRef.current?.(returnedIds);
            }
            if (statusTimerRef.current !== null)
              clearTimeout(statusTimerRef.current);
            statusTimerRef.current = setTimeout(
              () => setSyncStatus("idle"),
              2000,
            );
          } else {
            setSyncError(result.error ?? "自動同步失敗");
            setSyncStatus("error");
          }
        } catch (err) {
          setProgressMessage("");
          setSyncError(err instanceof Error ? err.message : "自動同步失敗");
          setSyncStatus("error");
        }
      })
      .catch((err) => {
        console.warn("[useBookSync] canAutoSync check failed:", err);
      });
  }, [userId, apiClient]);

  // Mechanism B: Manual sync (no rate limiting)
  const triggerManualSync = useCallback(async () => {
    // A manual sync supersedes the pending done→idle reset: letting the old
    // timer fire mid-sync flips syncStatus to "idle" and re-enables the sync
    // button, which is the only guard against a second concurrent syncBooks().
    if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
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
      setLastSync(lastSyncOf(result));
      setSyncStatus("done");
      const returnedIds = result.autoReturnedRequestIds;
      if (returnedIds && returnedIds.length > 0) {
        onAutoReturnedRef.current?.(returnedIds);
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
    lastSyncBooks: lastSync.books,
    lastSyncRenamedBooks: lastSync.renamedBooks,
    lastSyncLastUpdated: lastSync.lastUpdated,
    triggerManualSync,
    autoSyncDone,
    progressMessage,
    renamedBookCount: lastSync.renamedBookCount,
  };
}
