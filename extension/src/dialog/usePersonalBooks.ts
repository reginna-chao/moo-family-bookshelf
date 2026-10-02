import { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient, BookEntry, BoolFlag } from "../api/client";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import { dropResolvedLegacyBooks } from "../sync/legacyBooks";
import { loadSavedBooks } from "../sync/savedBooks";
import type { RenamedBook } from "../sync/renamedBooks";
import { useDirtyBookIds } from "./useDirtyBookIds";
import { useApplySyncResult } from "./useApplySyncResult";
import {
  useSavePersonalShelf,
  type PersonalBooksStatus,
} from "./useSavePersonalShelf";

export type { PersonalBooksStatus } from "./useSavePersonalShelf";

const NO_RENAMES: readonly RenamedBook[] = [];

export interface UsePersonalBooksParams {
  userId: string;
  apiClient: ApiClient;
  lastSyncBooks: BookEntry[];
  /** Books the sync that produced `lastSyncBooks` moved to a new id. */
  lastSyncRenamedBooks?: readonly RenamedBook[];
  /** The `lastUpdated` that same sync's PUT stored; the next full PUT's precondition. */
  lastSyncLastUpdated?: string;
  /** Server-authoritative display name. Avoids reading stale value from chrome.storage.local. */
  displayName: string;
}

export function usePersonalBooks({
  userId,
  apiClient,
  lastSyncBooks,
  lastSyncRenamedBooks = NO_RENAMES,
  lastSyncLastUpdated,
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
    lastSyncLastUpdated,
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

  const handleSave = useSavePersonalShelf({
    userId,
    apiClient,
    displayName,
    books,
    dirtyBookIds,
    dirtyRef,
    latestBooksRef,
    clearDirtyIds,
    setBooks,
    originalBooks,
    savedRawPayload,
    appliedSyncRef,
    setStatus,
    setErrorMessage,
  });

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
