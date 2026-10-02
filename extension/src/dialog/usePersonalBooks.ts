import { useState, useEffect, useCallback, useRef } from "react";
import browser from "webextension-polyfill";
import {
  ApiClient,
  BookEntry,
  BoolFlag,
  PERSONAL_BOOKS_SCHEMA_VERSION,
} from "../api/client";
import { decideSaveStrategy } from "moo-family-bookshelf-shared/personal/saveStrategy";
import { booksSaveErrorText } from "moo-family-bookshelf-shared/personal/saveErrors";
import { savedDirtyIds } from "moo-family-bookshelf-shared/personal/savedDirty";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import {
  PERSONAL_BOOKS_CACHE_KEY,
  PERSONAL_SHELF_SAVED_AT_KEY,
} from "../constants";
import { dropResolvedLegacyBooks } from "../sync/legacyBooks";
import { loadSavedBooks } from "../sync/savedBooks";
import type { RenamedBook } from "../sync/renamedBooks";
import { settleSavedShelf, type SavedShelf } from "./syncedShelf";
import { useDirtyBookIds } from "./useDirtyBookIds";
import { useApplySyncResult } from "./useApplySyncResult";

export type PersonalBooksStatus =
  "loading" | "ready" | "saving" | "saved" | "error";

/** Backend rejects PATCH `changes` arrays longer than this; fall back to PUT. */
const MAX_PATCH_CHANGES = 1000;

const NO_RENAMES: readonly RenamedBook[] = [];

export interface UsePersonalBooksParams {
  userId: string;
  apiClient: ApiClient;
  lastSyncBooks: BookEntry[];
  /** Books the sync that produced `lastSyncBooks` moved to a new id. */
  lastSyncRenamedBooks?: readonly RenamedBook[];
  /** Server-authoritative display name. Avoids reading stale value from chrome.storage.local. */
  displayName: string;
}

export function usePersonalBooks({
  userId,
  apiClient,
  lastSyncBooks,
  lastSyncRenamedBooks = NO_RENAMES,
  displayName,
}: UsePersonalBooksParams) {
  const [books, setBooks] = useState<BookEntry[]>([]);
  const latestBooksRef = useRef(books);
  latestBooksRef.current = books;
  const originalBooks = useRef<BookEntry[]>([]);
  /** Raw payload — kept so save can spread back unknown fields from future versions */
  const savedRawPayload = useRef<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<PersonalBooksStatus>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const {
    dirtyBookIds,
    dirtyRef,
    markDirty,
    markManyDirty,
    clearDirty,
    clearDirtyIds,
    moveRenamedDirty,
  } = useDirtyBookIds();
  const isDirty = dirtyBookIds.size > 0;
  /** Pending "saved" → "ready" reset; cleared on unmount and before rescheduling. */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Load the server list only, never the local cache (a cached id the server no
  // longer holds would be PUT back). Scraped books arrive via `lastSyncBooks`.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const apiResponse = await apiClient.getPersonalBooks(userId);
        if (cancelled) return;
        if (apiResponse.error) {
          setErrorMessage(safeErrorText(apiResponse.error.message, "載入失敗"));
          setStatus("error");
          return;
        }

        const saved = loadSavedBooks(apiResponse.data);
        savedRawPayload.current = saved.raw;
        // Resolved legacy entries dropped. Empty baseline → "ready" → "尚無書籍".
        const baseline = dropResolvedLegacyBooks(saved.books);
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

  /** The last applied sync result; handleSave compares it to spot a mid-save sync. */
  const appliedSyncRef = useRef<BookEntry[] | null>(null);
  useApplySyncResult({
    appliedSyncRef,
    lastSyncBooks,
    lastSyncRenamedBooks,
    loaded: status !== "loading",
    setBooks,
    dirtyRef,
    moveRenamedDirty,
    originalBooks,
    savedRawPayload,
  });

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

  // Clear only the ids this save really saved: a mid-save toggle stays dirty.
  const commitSaved = useCallback(
    (settled: SavedShelf, sentBooks: BookEntry[], sentIds: Set<string>) => {
      originalBooks.current = settled.baseline;
      savedRawPayload.current = {
        ...savedRawPayload.current,
        books: settled.serverBooks,
      };
      void browser.storage.local.set({
        [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(settled.baseline),
      });
      void browser.storage.local.set({
        [PERSONAL_SHELF_SAVED_AT_KEY]: Date.now(),
      });
      clearDirtyIds(savedDirtyIds(sentBooks, latestBooksRef.current, sentIds));
      setStatus("saved");
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus("ready"), 1500);
    },
    [clearDirtyIds],
  );

  const handleSave = useCallback(async () => {
    // Cancel a pending saved→ready reset: it would drop "saving" / "error".
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);

    // Nothing changed → treat as an instant no-op save (UI guards this too).
    if (dirtyBookIds.size === 0) {
      setStatus("saved");
      savedTimerRef.current = setTimeout(() => setStatus("ready"), 1500);
      return;
    }

    setStatus("saving");
    setErrorMessage("");
    const syncAtStart = appliedSyncRef.current;

    // PATCH, or a full PUT when a partial update can't be safe (saveStrategy).
    const { usePut, dirtyBooks, patchChanges } = decideSaveStrategy({
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
          booksSaveErrorText(response.error, "儲存失敗，請稍後再試"),
        );
        setStatus("error");
        return;
      }
      const syncNow = appliedSyncRef.current;
      const landedSync = syncNow !== syncAtStart ? syncNow : null;
      const sent = usePut
        ? dirtyBooks.map((b) => ({ bookId: b.bookId, isShared: b.isShared }))
        : patchChanges;
      const settled = settleSavedShelf({
        books,
        usePut,
        sent,
        serverBooks: savedRawPayload.current?.books,
        landedSync,
      });
      commitSaved(settled, books, dirtyBookIds);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setStatus("error");
    }
  }, [books, userId, apiClient, displayName, dirtyBookIds, commitSaved]);

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
