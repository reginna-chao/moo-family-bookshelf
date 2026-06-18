/**
 * Shared book sync infrastructure used by:
 * A) Auto full sync on personal-shelf mount (throttled by autoSyncInterval)
 * B) Manual sync button (no throttle)
 *
 * Both run a single complete scrape + upload. Background scheduled sync
 * (chrome.alarms) was removed — sync only happens when the user opens their
 * personal shelf.
 */

import browser from "webextension-polyfill";
import { ApiClient, BookEntry, BoolFlag, PersonalBooks, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";
import {
  AUTO_SYNC_INTERVAL_KEY,
  LAST_SYNC_AT_KEY,
  SYNC_ARCHIVED_KEY,
  DISPLAY_NAME_KEY,
} from "../constants";

// Re-export ApiClient so the content script can import it from content-sync.js
// instead of needing a separate content-api.js entry point.
export { ApiClient } from "../api/client";
import {
  ScrapedBook,
  scrapeBooks,
  scrapeArchivedBooks,
  type ScrapeProgressCallback,
} from "../content/scraper";
import { mergeBooks } from "./mergeBooks";

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

/** Delay (ms) to wait for page render after hash navigation */
const NAV_SETTLE_MS = 1500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared interval gate: enough time has passed since the timestamp at `timestampKey`,
 * relative to the user-configured `autoSyncInterval`.
 */
async function canSyncByInterval(timestampKey: string): Promise<boolean> {
  const result = await browser.storage.local.get([timestampKey, AUTO_SYNC_INTERVAL_KEY]);
  const interval = isAutoSyncInterval(result[AUTO_SYNC_INTERVAL_KEY])
    ? result[AUTO_SYNC_INTERVAL_KEY]
    : DEFAULT_AUTO_SYNC_INTERVAL;
  const minMs = AUTO_SYNC_INTERVALS_MS[interval];
  if (minMs === null) return false;
  const last = result[timestampKey] as number | undefined;
  if (!last) return true;
  return Date.now() - last >= minMs;
}

/**
 * Check if enough time has passed since the last full upload sync.
 */
export function canAutoSync(): Promise<boolean> {
  return canSyncByInterval(LAST_SYNC_AT_KEY);
}

/**
 * Parse saved books from the API response (now plaintext JSON).
 */
interface LoadSavedResult {
  books: BookEntry[];
  /** Full payload — preserved so save can merge back unknown fields */
  raw: Record<string, unknown> | null;
}

function loadSavedBooks(
  data: Record<string, unknown>,
): LoadSavedResult {
  if (Array.isArray(data.books)) {
    return { books: data.books as BookEntry[], raw: data };
  }
  return { books: [], raw: null };
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
}

export interface SyncBooksResult {
  success: boolean;
  books: BookEntry[];
  error?: string;
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
 * 3. Scrape books
 * 4. Merge with saved books (preserve isShared settings)
 * 5. Upload as plaintext JSON
 * 6. Navigate back if needed
 * 7. Update lastSyncAt
 */
export async function syncBooks(options: SyncBooksOptions): Promise<SyncBooksResult> {
  const { navigate, userId, apiClient, onProgress } = options;
  const originalHash = window.location.hash;
  const isOnLibrary = originalHash.includes("#/library");

  try {
    // Step 1+2: Navigate to library page if needed
    if (navigate && !isOnLibrary) {
      window.location.hash = "#/library";
      await wait(NAV_SETTLE_MS);
    }

    // Step 3: Scrape books
    const scrapedBooks: ScrapedBook[] = await scrapeBooks({ onProgress });

    // Step 3b: Optionally scrape archived books
    let syncArchived = BoolFlag.FALSE;
    try {
      const archiveResult = await browser.storage.local.get([SYNC_ARCHIVED_KEY]);
      syncArchived = (archiveResult[SYNC_ARCHIVED_KEY] as number | undefined) ?? BoolFlag.FALSE;
    } catch {
      // Archive setting unavailable — skip archive sync
    }

    let allScrapedBooks: ScrapedBook[] = [...scrapedBooks];

    if (syncArchived === BoolFlag.TRUE) {
      const archivedBooks = await scrapeArchivedBooks({ onProgress });
      allScrapedBooks = [...allScrapedBooks, ...archivedBooks];
    }

    // Step 4: Fetch existing saved books for merge
    const storageResult = await browser.storage.local.get([DISPLAY_NAME_KEY]);

    let savedBooks: BookEntry[] = [];
    let savedRawPayload: Record<string, unknown> | null = null;
    const apiResponse = await apiClient.getPersonalBooks(userId);
    if (apiResponse.data) {
      const result = loadSavedBooks(
        apiResponse.data as unknown as Record<string, unknown>,
      );
      savedBooks = result.books;
      savedRawPayload = result.raw;
    }

    const merged = mergeBooks(allScrapedBooks, savedBooks);

    // Step 5: Build PersonalBooks object and upload as plaintext JSON
    const displayName = (storageResult[DISPLAY_NAME_KEY] as string | undefined) ?? "";
    const personalBooks: PersonalBooks = {
      ...savedRawPayload,
      schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
      userId,
      displayName,
      books: merged,
      lastUpdated: new Date().toISOString(),
    };
    const uploadResponse = await apiClient.updatePersonalBooks(userId, personalBooks);

    if (uploadResponse.error) {
      throw new Error(uploadResponse.error.message);
    }

    // Step 6: Navigate back if we navigated away
    if (navigate && !isOnLibrary) {
      window.location.hash = originalHash || "#/";
    }

    // Step 7: Record this successful sync so the auto-sync throttle (canAutoSync)
    // honours the user's configured interval before syncing again.
    await browser.storage.local.set({ [LAST_SYNC_AT_KEY]: Date.now() });

    return { success: true, books: merged };
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
