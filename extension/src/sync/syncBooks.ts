/**
 * Shared book sync infrastructure used by:
 * A) Auto-detect sync (dialog open + #/library)
 * B) Background scheduled sync (chrome.alarms)
 * C) Manual sync button
 */

import { ApiClient, BookEntry, BoolFlag, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";

// Re-export ApiClient so the content script can import it from content-sync.js
// instead of needing a separate content-api.js entry point.
export { ApiClient } from "../api/client";
import { ScrapedBook, scrapeBooks, scrapeArchivedBooks } from "../content/scraper";
import { importKey, encrypt, decrypt } from "../crypto/encrypt";
import { mergeBooks } from "./mergeBooks";

/** Minimum interval (ms) for rate-limited auto-sync */
export const AUTO_SYNC_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Interval for background scheduled sync */
export const BACKGROUND_SYNC_INTERVAL_MIN = 24 * 60; // 24 hours in minutes

/** Chrome alarm name for background sync */
export const BOOK_SYNC_ALARM_NAME = "bookSync";

/** Delay (ms) to wait for page render after hash navigation */
const NAV_SETTLE_MS = 1500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if enough time has passed since the last sync for rate-limited sync.
 */
export async function canAutoSync(): Promise<boolean> {
  const result = await chrome.storage.local.get(["lastSyncAt"]);
  const lastSyncAt = result.lastSyncAt as number | undefined;
  if (!lastSyncAt) return true;
  return Date.now() - lastSyncAt >= AUTO_SYNC_MIN_INTERVAL_MS;
}

/**
 * Decrypt and parse saved books from the API response.
 */
interface LoadSavedResult {
  books: BookEntry[];
  /** Full decrypted payload — preserved so save can merge back unknown fields */
  raw: Record<string, unknown> | null;
}

async function loadSavedBooks(
  data: Record<string, unknown>,
  encKeyString: string,
): Promise<LoadSavedResult> {
  if (typeof data.payload === "string") {
    const key = await importKey(encKeyString);
    const decrypted = await decrypt(data.payload, key);
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    const books = Array.isArray(parsed.books) ? (parsed.books as BookEntry[]) : [];
    return { books, raw: parsed };
  }
  if (Array.isArray(data.books)) {
    return { books: data.books as BookEntry[], raw: null };
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
}

export interface SyncBooksResult {
  success: boolean;
  books: BookEntry[];
  error?: string;
}

/**
 * Core sync function shared by all three mechanisms.
 *
 * 1. Navigate to #/library if needed
 * 2. Wait for render
 * 3. Scrape books
 * 4. Merge with saved books (preserve isShared settings)
 * 5. Encrypt and upload
 * 6. Navigate back if needed
 * 7. Update lastSyncAt
 */
export async function syncBooks(options: SyncBooksOptions): Promise<SyncBooksResult> {
  const { navigate, userId, apiClient } = options;
  const originalHash = window.location.hash;
  const isOnLibrary = originalHash.includes("#/library");

  try {
    // Step 1+2: Navigate to library page if needed
    if (navigate && !isOnLibrary) {
      window.location.hash = "#/library";
      await wait(NAV_SETTLE_MS);
    }

    // Step 3: Scrape books
    const scrapedBooks: ScrapedBook[] = await scrapeBooks();

    // Step 3b: Optionally scrape archived books
    let syncArchived = BoolFlag.FALSE;
    try {
      const archiveResult = await chrome.storage.local.get(["syncArchived"]);
      syncArchived = (archiveResult.syncArchived as number | undefined) ?? BoolFlag.FALSE;
    } catch {
      // Archive setting unavailable — skip archive sync
    }

    let allScrapedBooks: ScrapedBook[] = [...scrapedBooks];

    if (syncArchived === BoolFlag.TRUE) {
      const archivedBooks = await scrapeArchivedBooks();
      allScrapedBooks = [...allScrapedBooks, ...archivedBooks];
    }

    // Step 4: Fetch existing saved books for merge
    const storageResult = await chrome.storage.local.get(["encryptionKey", "displayName"]);
    const encKeyString = storageResult.encryptionKey as string | undefined;
    if (!encKeyString) {
      throw new Error("找不到加密金鑰");
    }

    let savedBooks: BookEntry[] = [];
    let savedRawPayload: Record<string, unknown> | null = null;
    const apiResponse = await apiClient.getPersonalBooks(userId);
    if (apiResponse.data) {
      try {
        const result = await loadSavedBooks(
          apiResponse.data as unknown as Record<string, unknown>,
          encKeyString,
        );
        savedBooks = result.books;
        savedRawPayload = result.raw;
      } catch {
        // Decryption failed — treat as no saved data
        console.warn("[syncBooks] Decrypt failed, ignoring saved data");
        savedBooks = [];
      }
    }

    const merged = mergeBooks(allScrapedBooks, savedBooks);

    // Step 5: Encrypt and upload (spread savedRawPayload to preserve unknown fields from future versions)
    const key = await importKey(encKeyString);
    const displayName = (storageResult.displayName as string | undefined) ?? "";
    const payload = JSON.stringify({
      ...savedRawPayload,
      schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
      userId,
      displayName,
      books: merged,
      lastUpdated: new Date().toISOString(),
    });
    const encrypted = await encrypt(payload, key);
    const uploadResponse = await apiClient.updatePersonalBooks(userId, encrypted);

    if (uploadResponse.error) {
      throw new Error(uploadResponse.error.message);
    }

    // Step 6: Navigate back if we navigated away
    if (navigate && !isOnLibrary) {
      window.location.hash = originalHash || "#/";
    }

    // Step 7: Update lastSyncAt
    await chrome.storage.local.set({ lastSyncAt: Date.now() });

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
