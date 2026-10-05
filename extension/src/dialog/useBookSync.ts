/**
 * Hook for book sync in the dialog UI.
 * Provides:
 * - Auto-sync on personal-shelf mount (a full sync, rate limited by autoSyncInterval)
 * - Manual sync button handler (no rate limiting)
 *
 * Reads the account check from AccountCheckContext (issue #271): while the
 * page's Readmoo account is unconfirmed, auto-sync is skipped and a manual sync
 * re-checks first. With a confirmed account it behaves exactly as before.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ApiClient, BookEntry } from "../api/client";
import { syncBooks, canAutoSync } from "../sync/syncBooks";
import type { RenamedBook } from "../sync/renamedBooks";
import { formatScrapeProgress } from "../content/scraper";
import { type LastSync, NO_SYNC, lastSyncOf } from "./lastSync";
import {
  ACCOUNT_UNCONFIRMED_SYNC_MESSAGE,
  useAccountCheck,
} from "./AccountCheckContext";

export type SyncStatus = "idle" | "syncing" | "done" | "error";

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
  // Ref for the same reason: a status flip must not re-run the mount effect
  // (a manual sync that just confirmed the account is already syncing).
  const account = useAccountCheck();
  const accountRef = useRef(account);
  accountRef.current = account;

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
    // Unconfirmed account: never upload without a click this page load.
    if (accountRef.current.status !== "match") return;
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

    if (accountRef.current.status !== "match") {
      const identity = await accountRef.current.recheck();
      if (identity === "unknown") {
        setSyncError(ACCOUNT_UNCONFIRMED_SYNC_MESSAGE);
        setSyncStatus("error");
      }
      // A mismatch swaps the Dialog to the blocking screen (this shelf unmounts).
      if (identity === "mismatch") setSyncStatus("idle");
      if (identity !== "match") return;
    }

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
