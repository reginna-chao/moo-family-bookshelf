/** Book sync shared by (A) the auto full sync on personal-shelf mount (throttled by autoSyncInterval)
 *  and (B) the manual sync button (no throttle). See docs/architecture.md → 書單同步. */

import browser from "webextension-polyfill";
import { ApiClient, BookEntry } from "../api/client";
import {
  AUTO_SYNC_INTERVAL_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
} from "../constants";

// Re-export ApiClient so the content script can import it from content-sync.js
// instead of needing a separate content-api.js entry point.
export { ApiClient } from "../api/client";
import { type ScrapeProgressCallback } from "../content/scraper";
import { NAV_SETTLE_MS, settleMsLeft, wait } from "../content/hashNavigation";
import { resetScrapeWarnings } from "../content/readmoo-dom";
import { runAutoReturn } from "./autoReturn";
import type { RenamedBook } from "./renamedBooks";
import { fetchBorrowRequestsForSync, scrapeForSync } from "./syncSteps";
import {
  fetchSavedBooksForSync,
  uploadSyncBooksRereadingOnConflict,
} from "./syncUpload";

/** User-configurable auto-sync frequency */
export type AutoSyncInterval = "daily" | "weekly" | "monthly" | "never";

/** Single source of truth: interval value (ms); `never` → null = disabled */
export const AUTO_SYNC_INTERVALS_MS: Record<AutoSyncInterval, number | null> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  never: null,
};

export const DEFAULT_AUTO_SYNC_INTERVAL: AutoSyncInterval = "daily";

/** Type guard for AutoSyncInterval */
export function isAutoSyncInterval(v: unknown): v is AutoSyncInterval {
  return v === "daily" || v === "weekly" || v === "monthly" || v === "never";
}

/** Interval gate: enough time has passed since the timestamp at `timestampKey` for the
 *  user-configured `autoSyncInterval` (`never` → always false). */
async function canSyncByInterval(timestampKey: string): Promise<boolean> {
  const result = await browser.storage.local.get([
    timestampKey,
    AUTO_SYNC_INTERVAL_KEY,
  ]);
  const interval = isAutoSyncInterval(result[AUTO_SYNC_INTERVAL_KEY])
    ? result[AUTO_SYNC_INTERVAL_KEY]
    : DEFAULT_AUTO_SYNC_INTERVAL;
  const minMs = AUTO_SYNC_INTERVALS_MS[interval];
  if (minMs === null) return false;
  const last = result[timestampKey] as number | undefined;
  if (!last) return true;
  return Date.now() - last >= minMs;
}

/** Check if enough time has passed since the last full upload sync. */
export function canAutoSync(): Promise<boolean> {
  return canSyncByInterval(LAST_SYNC_AT_KEY);
}

export interface SyncBooksOptions {
  /** Navigate to #/library before scraping (and restore hash after) */
  navigate: boolean;
  /** The userId for API calls */
  userId: string;
  /** API client instance */
  apiClient: ApiClient;
  /** Optional progress callback for the paginated scrape (Wave G) */
  onProgress?: ScrapeProgressCallback;
  /** When present, the borrow list is fetched once before upload: lent books are shielded from
   *  id-change resolution, and reappeared books get their LENT requests marked RETURNED after it. */
  familyId?: string;
}

export interface SyncBooksResult {
  success: boolean;
  books: BookEntry[];
  error?: string;
  /** RequestIds of LENT requests auto-marked RETURNED this sync (best-effort); callers derive the
   *  count via `.length` and apply the local status change. */
  autoReturnedRequestIds?: string[];
  /** Saved books replaced by their new Readmoo id this sync (`sync/renamedBooks.ts`). */
  renamedBooks?: RenamedBook[];
  /** Always `renamedBooks.length` on success. */
  renamedBookCount?: number;
  /** The `lastUpdated` this sync's own landed PUT stored (`SyncUploadResult`). */
  lastUpdated?: string;
}

/**
 * Core sync function shared by all callers.
 *
 * NOTE: As of the single-full-sync consolidation, every caller (auto full sync
 * on personal-shelf mount AND the manual sync button) passes `navigate: true`.
 * The `navigate: false` path currently has no caller. The full navigate logic
 * is intentionally retained for the `navigate: true` case (and any future
 * caller that already sits on #/library); do not remove it.
 *
 * 1. Navigate to #/library if needed
 * 2. Wait for render
 * 3. Scrape books (+ archive when enabled)
 * 4. Merge with saved books (preserve isShared settings); circuit breaker;
 *    id-change resolution
 * 5. Upload as plaintext JSON; a save that lands meanwhile re-runs step 4
 * 6. Navigate back if needed
 * 7. Update lastSyncAt
 */
export async function syncBooks(
  options: SyncBooksOptions,
): Promise<SyncBooksResult> {
  const { navigate, userId, apiClient, onProgress, familyId } = options;
  const originalHash = window.location.hash;
  const isOnLibrary = originalHash.includes("#/library");

  // Reset warn-once state per sync, not per page load (the SPA stays open for days): a degraded path
  // (legacy selector, rejected bookId) must warn on every sync, not only the first.
  resetScrapeWarnings();

  try {
    // Step 1+2: Navigate to library page if needed. Otherwise a hash that an
    // account check (#/me) just put back may still be rendering: wait it out.
    if (navigate && !isOnLibrary) {
      window.location.hash = "#/library";
      await wait(NAV_SETTLE_MS);
    } else {
      const settleMs = settleMsLeft();
      if (settleMs > 0) await wait(settleMs);
    }

    // Step 3: Scrape books (+ archived books when 同步封存書 is on)
    const scrape = await scrapeForSync(onProgress);
    const scrapedIds = new Set(scrape.books.map((b) => b.bookId));

    // Step 4: Read the saved books for merge. A failed read or a
    // redesign-shaped scrape throws here (no upload, no lastSyncAt).
    const storageResult = await browser.storage.local.get([DISPLAY_NAME_KEY]);
    const read = { apiClient, userId, scrape, scrapedIds };
    const firstRead = await fetchSavedBooksForSync(read);
    const requests = familyId
      ? await fetchBorrowRequestsForSync(apiClient, familyId)
      : null;

    // Step 5: Merge, resolve ids and upload; a conflict re-reads and retries.
    const displayName =
      (storageResult[DISPLAY_NAME_KEY] as string | undefined) ?? "";
    const upload = await uploadSyncBooksRereadingOnConflict(
      { ...read, familyId, displayName, requests },
      firstRead,
    );

    // Step 6: Navigate back if we navigated away
    if (navigate && !isOnLibrary) {
      window.location.hash = originalHash || "#/";
    }

    // Step 7: Record this successful sync so the auto-sync throttle (canAutoSync)
    // honours the user's configured interval before syncing again.
    await browser.storage.local.set({ [LAST_SYNC_AT_KEY]: Date.now() });

    // Step 8 (best-effort, never affects the sync result): mark returned books' LENT requests
    // RETURNED, reusing the pre-upload borrow list (skipped when that fetch failed).
    let autoReturnedRequestIds: string[] | undefined;
    if (familyId) {
      autoReturnedRequestIds = requests
        ? await runAutoReturn(apiClient, requests, userId, scrapedIds)
        : [];
    }

    return {
      success: true,
      ...upload,
      autoReturnedRequestIds,
      renamedBookCount: upload.renamedBooks.length,
    };
  } catch (err) {
    // Restore navigation on error
    if (navigate && !isOnLibrary) {
      window.location.hash = originalHash || "#/";
    }
    return {
      success: false,
      books: [],
      error: err instanceof Error ? err.message : "同步失敗",
    };
  }
}
