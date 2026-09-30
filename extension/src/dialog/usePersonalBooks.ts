import { useState, useEffect, useCallback, useRef } from "react";
import browser from "webextension-polyfill";
import {
  ApiClient,
  BookEntry,
  BoolFlag,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "../api/client";
import {
  applyPatchChanges,
  decideSaveStrategy,
} from "moo-family-bookshelf-shared/personal/saveStrategy";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import {
  PERSONAL_BOOKS_CACHE_KEY,
  PERSONAL_SHELF_SAVED_AT_KEY,
} from "../constants";
import { mergeBooks } from "./mergeBooks";
import { dropResolvedLegacyBooks, isRealBookId } from "../sync/legacyBooks";

export type PersonalBooksStatus =
  "loading" | "ready" | "saving" | "saved" | "error";

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

function loadSavedBooks(data: Record<string, unknown>): LoadSavedResult {
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
 * Pre-scrape baseline: cache reconciled against the server (API wins on share
 * flags), API-only books appended, legacy entries resolved to a real one dropped.
 * A cache-only legacy entry is stale (never scraped): dropped, its flag unused.
 */
function reconcileBaseline(
  cached: BookEntry[],
  saved: BookEntry[],
): BookEntry[] {
  const savedMap = new Map(saved.map((b) => [b.bookId, b]));
  const cachedIds = new Set(cached.map((b) => b.bookId));
  const reconciled = cached.flatMap((b) => {
    const apiBook = savedMap.get(b.bookId);
    if (apiBook) return [{ ...b, isShared: apiBook.isShared }];
    return isRealBookId(b.bookId) ? [b] : [];
  });
  const apiOnly = saved.filter((b) => !cachedIds.has(b.bookId));
  return dropResolvedLegacyBooks([...reconciled, ...apiOnly]);
}

export function usePersonalBooks({
  userId,
  apiClient,
  lastSyncBooks,
  displayName,
}: UsePersonalBooksParams) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const originalBooks = useRef<BookEntry[]>([]);
  /** Raw payload — kept so save can spread back unknown fields from future versions */
  const savedRawPayload = useRef<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<PersonalBooksStatus>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [dirtyBookIds, setDirtyBookIds] = useState<Set<string>>(new Set());
  const isDirty = dirtyBookIds.size > 0;
  const dirtyRef = useRef(dirtyBookIds);
  dirtyRef.current = dirtyBookIds;
  /** Pending "saved" → "ready" reset; cleared on unmount and before rescheduling. */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

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

  // Load books: cache-first display only (no scrape here). The actual scrape +
  // upload happens in useBookSync's auto full sync, which refreshes the cache and
  // streams results back via `lastSyncBooks` (merged by the effect below).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Independent reads — run in parallel to shorten shelf load latency.
        const [cacheResult, apiResponse] = await Promise.all([
          browser.storage.local.get([PERSONAL_BOOKS_CACHE_KEY]),
          apiClient.getPersonalBooks(userId),
        ]);
        if (cancelled) return;

        let savedBooks: BookEntry[] = [];
        if (apiResponse.data) {
          const result = loadSavedBooks(
            apiResponse.data as unknown as Record<string, unknown>,
          );
          savedBooks = result.books;
          savedRawPayload.current = result.raw;
        }
        const cachedBooks = parseCachedBooks(
          cacheResult[PERSONAL_BOOKS_CACHE_KEY],
        );

        // Cache reconciled against the server, else the server list; resolved
        // legacy entries dropped on both. Empty baseline → "ready" → "尚無書籍".
        const baseline =
          cachedBooks.length > 0
            ? reconcileBaseline(cachedBooks, savedBooks)
            : dropResolvedLegacyBooks(savedBooks);
        originalBooks.current = baseline;
        setBooks(baseline);
        setStatus("ready");
      } catch (err) {
        console.error("[PersonalShelf] Error:", err);
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : "載入失敗");
        setStatus("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [userId, apiClient]);

  // Merge sync results into display + cancel baseline (mergeBooks keeps the 2nd
  // arg's isShared). Display merges into `prev`, dirty ids never promoted, so
  // unsaved toggles win; the baseline merges into the clean baseline, holding
  // no unsaved toggle (save-before-sync, Invariant 3).
  useEffect(() => {
    if (lastSyncBooks.length > 0 && status === "ready") {
      const mapped = lastSyncBooks.map((b) => ({
        bookId: b.bookId,
        title: b.title,
        author: b.author,
        coverUrl: b.coverUrl,
        readmooUrl: b.readmooUrl,
        category: b.category,
        isArchived: b.isArchived ?? BoolFlag.FALSE,
      }));
      setBooks((prev) => mergeBooks(mapped, prev, dirtyRef.current));
      originalBooks.current = mergeBooks(mapped, originalBooks.current);
    }
  }, [lastSyncBooks, status]);

  const handleToggle = useCallback(
    (bookId: string) => {
      setBooks((prev) =>
        prev.map((b) =>
          b.bookId === bookId
            ? {
                ...b,
                isShared:
                  b.isShared === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE,
              }
            : b,
        ),
      );
      markDirty(bookId);
    },
    [markDirty],
  );

  const handleSave = useCallback(async () => {
    // A new save supersedes any pending saved→ready reset: letting the old timer
    // fire mid-flight would drop the UI out of "saving" (and out of "error").
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);

    // Nothing changed → treat as an instant no-op save (UI guards this too).
    if (dirtyBookIds.size === 0) {
      setStatus("saved");
      savedTimerRef.current = setTimeout(() => setStatus("ready"), 1500);
      return;
    }

    setStatus("saving");
    setErrorMessage("");

    // PATCH, or a full PUT when a partial update can't be safe (saveStrategy).
    const { usePut, patchChanges } = decideSaveStrategy({
      books,
      dirtyBookIds,
      savedRawPayload: savedRawPayload.current,
      maxPatchChanges: MAX_PATCH_CHANGES,
      includePromoted: true, // load-time legacy resolution can promote twins
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
        : await apiClient.patchPersonalBooks(userId, patchChanges);
      if (response.error) {
        setErrorMessage(
          safeErrorText(response.error.message, "儲存失敗，請稍後再試"),
        );
        setStatus("error");
        return;
      }
      originalBooks.current = books;
      // PATCH adds no ids; marking un-synced books known would lose them.
      const prev = savedRawPayload.current ?? {};
      const next = usePut ? books : applyPatchChanges(prev.books, patchChanges);
      savedRawPayload.current = { ...prev, books: next };
      void browser.storage.local.set({
        [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(books),
      });
      void browser.storage.local.set({
        [PERSONAL_SHELF_SAVED_AT_KEY]: Date.now(),
      });
      clearDirty();
      setStatus("saved");
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus("ready"), 1500);
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
  };
}
