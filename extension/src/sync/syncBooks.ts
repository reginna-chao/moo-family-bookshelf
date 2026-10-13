/** Book sync shared by (A) the auto full sync on personal-shelf mount (throttled by autoSyncInterval)
 *  and (B) the manual sync button (no throttle). See docs/architecture.md → 書單同步. */

import browser from "webextension-polyfill";
import {
  AUTO_SYNC_INTERVAL_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
} from "../constants";

// Re-export ApiClient so the content script can import it from content-sync.js
// instead of needing a separate content-api.js entry point.
export { ApiClient } from "../api/client";
// The option / result types moved to syncTypes.ts; re-exported so existing importers keep working.
export type { SyncBooksOptions, SyncBooksResult } from "./syncTypes";
import type { SyncBooksOptions, SyncBooksResult } from "./syncTypes";
import { NAV_SETTLE_MS, settleMsLeft, wait } from "../content/hashNavigation";
import { resetScrapeWarnings } from "../content/readmoo-dom";
import { runAutoReturn } from "./autoReturn";
import { fetchBorrowRequestsForSync, scrapeForSync } from "./syncSteps";
import {
  fetchSavedBooksForSync,
  readSavedBooksForSync,
  uploadSyncBooksRereadingOnConflict,
} from "./syncUpload";
import {
  DEFAULT_AUTO_SYNC_INTERVAL,
  isAutoSyncInterval,
  type AutoSyncInterval,
} from "../storage/autoSyncInterval";

/** Single source of truth: interval value (ms); `never` → null = disabled */
export const AUTO_SYNC_INTERVALS_MS: Record<AutoSyncInterval, number | null> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  never: null,
};

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
 * 3. Read the saved books once to fix the prune candidates (nothing else)
 * 4. Scrape books (+ archive when enabled)
 * 5. Read the saved books for merge; circuit breaker
 * 6. Merge (preserve isShared), resolve id changes, prune step-3 books Readmoo no longer holds
 * 7. Upload as plaintext JSON; a save that lands meanwhile re-reads and
 *    re-runs step 6 (prune candidates stay those of step 3)
 * 8. Navigate back if needed
 * 9. Update lastSyncAt
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

    // Step 3: Fix the prune candidates before scraping, so a book another device adds meanwhile is never
    // pruned; the upload basis is read again after the scrape (docs/architecture.md → 書單同步).
    const preScrape = await readSavedBooksForSync({ apiClient, userId });
    const preScrapeServerIds = new Set(preScrape.books.map((b) => b.bookId));

    // Step 4+5: Scrape books (+ archived books when 同步封存書 is on), then read the saved books to merge
    // with; a failed read or a redesign-shaped scrape throws there (no upload, no lastSyncAt).
    const scrape = await scrapeForSync(onProgress);
    const scrapedIds = new Set(scrape.books.map((b) => b.bookId));
    const storageResult = await browser.storage.local.get([DISPLAY_NAME_KEY]);
    const read = { apiClient, userId, scrape, scrapedIds };
    const firstRead = await fetchSavedBooksForSync(read);
    const requests = familyId
      ? await fetchBorrowRequestsForSync(apiClient, familyId)
      : null;

    // Step 6+7: Merge, resolve ids, prune and upload; a conflict re-reads and retries.
    const displayName =
      (storageResult[DISPLAY_NAME_KEY] as string | undefined) ?? "";
    const { removedCount, ...upload } =
      await uploadSyncBooksRereadingOnConflict(
        { ...read, preScrapeServerIds, familyId, displayName, requests },
        firstRead,
      );

    // Step 8: Navigate back if we navigated away
    if (navigate && !isOnLibrary) {
      window.location.hash = originalHash || "#/";
    }

    // Step 9: Record this successful sync so the auto-sync throttle (canAutoSync)
    // honours the user's configured interval before syncing again.
    await browser.storage.local.set({ [LAST_SYNC_AT_KEY]: Date.now() });

    // Step 10 (best-effort, never affects the sync result): mark returned books' LENT requests
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
      removedBookCount: removedCount,
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
