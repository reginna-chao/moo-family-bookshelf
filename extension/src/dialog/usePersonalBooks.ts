import { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient, BookEntry, BoolFlag, PERSONAL_BOOKS_SCHEMA_VERSION } from "../api/client";
import { decideSaveStrategy } from "moo-family-bookshelf-shared/personal/saveStrategy";
import { scrapeBooks, scrapeArchivedBooks, formatScrapeProgress } from "../content/scraper";
import {
  PERSONAL_BOOKS_CACHE_KEY,
  SYNC_ARCHIVED_KEY,
  LAST_DISPLAY_SCRAPE_AT_KEY,
  PERSONAL_SHELF_SAVED_AT_KEY,
} from "../constants";
import { mergeBooks } from "./mergeBooks";
import { canDisplayScrape } from "../sync/syncBooks";

export type PersonalBooksStatus = "scraping" | "ready" | "saving" | "saved" | "error";

/** Backend rejects PATCH `changes` arrays longer than this; fall back to PUT. */
const MAX_PATCH_CHANGES = 1000;

export interface UsePersonalBooksParams {
  userId: string;
  apiClient: ApiClient;
  lastSyncBooks: BookEntry[];
  /** Server-authoritative display name. Avoids reading stale value from chrome.storage.local. */
  displayName: string;
}

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

/** Parse the cached `BookEntry[]` (stored as JSON string). Defensive: returns [] on any failure. */
function parseCachedBooks(raw: unknown): BookEntry[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BookEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Build the pre-scrape baseline: cached book list with share flags
 * reconciled against the server (API wins for known books; cache value
 * retained for cache-only books). API-only books are appended.
 */
function reconcileBaseline(cached: BookEntry[], saved: BookEntry[]): BookEntry[] {
  const savedMap = new Map(saved.map((b) => [b.bookId, b]));
  const cachedIds = new Set(cached.map((b) => b.bookId));
  const reconciled = cached.map((b) => {
    const apiBook = savedMap.get(b.bookId);
    return apiBook ? { ...b, isShared: apiBook.isShared } : b;
  });
  const apiOnly = saved.filter((b) => !cachedIds.has(b.bookId));
  return [...reconciled, ...apiOnly];
}

export function usePersonalBooks({ userId, apiClient, lastSyncBooks, displayName }: UsePersonalBooksParams) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const originalBooks = useRef<BookEntry[]>([]);
  /** Raw payload — kept so save can spread back unknown fields from future versions */
  const savedRawPayload = useRef<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<PersonalBooksStatus>("scraping");
  const [errorMessage, setErrorMessage] = useState("");
  const [dirtyBookIds, setDirtyBookIds] = useState<Set<string>>(new Set());
  const isDirty = dirtyBookIds.size > 0;
  const [progressMessage, setProgressMessage] = useState("");

  const markDirty = useCallback((bookId: string) => {
    setDirtyBookIds((prev) => {
      if (prev.has(bookId)) return prev;
      const next = new Set(prev);
      next.add(bookId);
      return next;
    });
  }, []);

  const markManyDirty = useCallback((bookIds: Iterable<string>) => {
    setDirtyBookIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of bookIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const clearDirty = useCallback(() => {
    setDirtyBookIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  // Load books: cache-first display, then interval-gated scrape (the only scrolling path).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Step 1: cache + API together (no scrape yet).
        const cacheResult = await chrome.storage.local.get([PERSONAL_BOOKS_CACHE_KEY]);
        const apiResponse = await apiClient.getPersonalBooks(userId);
        if (cancelled) return;

        let savedBooks: BookEntry[] = [];
        if (apiResponse.data) {
          const result = loadSavedBooks(
            apiResponse.data as unknown as Record<string, unknown>,
          );
          savedBooks = result.books;
          savedRawPayload.current = result.raw;
        }
        const cachedBooks = parseCachedBooks(cacheResult[PERSONAL_BOOKS_CACHE_KEY]);

        // Step 2: baseline display WITHOUT scraping.
        const baseline = cachedBooks.length > 0 ? reconcileBaseline(cachedBooks, savedBooks) : savedBooks;
        if (baseline.length > 0) {
          originalBooks.current = baseline;
          setBooks(baseline);
          setStatus("ready");
        }

        // Step 3: interval gate.
        const allowed = await canDisplayScrape();
        if (cancelled) return;
        if (!allowed) {
          if (baseline.length === 0) setStatus("ready");
          return;
        }

        // Step 4: allowed → scrape (the only path that scrolls the library page).
        const onProgress = (page: number, count: number) => {
          if (!cancelled) setProgressMessage(formatScrapeProgress(page, count));
        };
        const scrapedBooks = await scrapeBooks({ onProgress });

        const archiveResult = await chrome.storage.local.get([SYNC_ARCHIVED_KEY]);
        const syncArchivedSetting = (archiveResult[SYNC_ARCHIVED_KEY] as number | undefined) ?? BoolFlag.FALSE;
        let allScrapedBooks = [...scrapedBooks];
        if (syncArchivedSetting === BoolFlag.TRUE) {
          const archivedBooks = await scrapeArchivedBooks({ onProgress });
          allScrapedBooks = [...scrapedBooks, ...archivedBooks];
        }
        if (cancelled) return;

        const merged = mergeBooks(allScrapedBooks, savedBooks);
        chrome.storage.local.set({ [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(merged), [LAST_DISPLAY_SCRAPE_AT_KEY]: Date.now() });
        originalBooks.current = merged;
        setBooks(merged);
        setStatus("ready");
        setProgressMessage("");
      } catch (err) {
        console.error("[PersonalShelf] Error:", err);
        if (cancelled) return;
        setProgressMessage("");
        setErrorMessage(err instanceof Error ? err.message : "載入失敗");
        setStatus("error");
      }
    }

    load();
    return () => { cancelled = true; };
  }, [userId, apiClient]);

  // Merge new books from auto-sync or manual sync
  useEffect(() => {
    if (lastSyncBooks.length > 0 && status === "ready") {
      setBooks((prev) => mergeBooks(
        lastSyncBooks.map((b) => ({
          bookId: b.bookId,
          title: b.title,
          author: b.author,
          coverUrl: b.coverUrl,
          readmooUrl: b.readmooUrl,
          category: b.category,
          isArchived: b.isArchived ?? BoolFlag.FALSE,
        })),
        prev,
      ));
    }
  }, [lastSyncBooks, status]);

  const handleToggle = useCallback((bookId: string) => {
    setBooks((prev) =>
      prev.map((b) => (b.bookId === bookId ? { ...b, isShared: b.isShared === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE } : b)),
    );
    markDirty(bookId);
  }, [markDirty]);

  const handleSave = useCallback(async () => {
    // Nothing changed → treat as an instant no-op save (UI guards this too).
    if (dirtyBookIds.size === 0) {
      setStatus("saved");
      setTimeout(() => setStatus("ready"), 1500);
      return;
    }

    setStatus("saving");
    setErrorMessage("");

    // PATCH only the dirty books, unless the diff can't be safely expressed as
    // a partial update (new un-synced books, no server record, or over the cap)
    // — those fall back to a full PUT so nothing is silently dropped.
    const { usePut, dirtyBooks } = decideSaveStrategy({
      books,
      dirtyBookIds,
      savedRawPayload: savedRawPayload.current,
      maxPatchChanges: MAX_PATCH_CHANGES,
    });

    try {
      const response = usePut
        ? await apiClient.updatePersonalBooks(userId, {
            ...savedRawPayload.current,
            schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
            userId,
            displayName,
            books,
            lastUpdated: new Date().toISOString(),
          })
        : await apiClient.patchPersonalBooks(
            userId,
            dirtyBooks.map((b) => ({ bookId: b.bookId, isShared: b.isShared })),
          );
      if (response.error) {
        setErrorMessage(response.error.message);
        setStatus("error");
        return;
      }
      originalBooks.current = books;
      // Only a PUT persists the full local list; a PATCH leaves the server's
      // book set unchanged (it can only update isShared of existing books).
      // Marking PATCH-time books as server-known would wrongly classify
      // un-synced scraped books as known and silently drop them on a later PATCH.
      if (usePut) {
        savedRawPayload.current = { ...(savedRawPayload.current ?? {}), books };
      }
      chrome.storage.local.set({ [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(books) });
      chrome.storage.local.set({ [PERSONAL_SHELF_SAVED_AT_KEY]: Date.now() });
      clearDirty();
      setStatus("saved");
      setTimeout(() => setStatus("ready"), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setStatus("error");
    }
  }, [books, userId, apiClient, displayName, clearDirty, dirtyBookIds]);

  const handleCancel = useCallback(() => {
    setBooks(originalBooks.current);
    clearDirty();
  }, [clearDirty]);

  return {
    books,
    setBooks,
    status,
    setStatus,
    errorMessage,
    isDirty,
    dirtyBookIds,
    markDirty,
    markManyDirty,
    clearDirty,
    originalBooks,
    handleToggle,
    handleSave,
    handleCancel,
    progressMessage,
  };
}
