import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import browser from "webextension-polyfill";
import type { ApiClient, BookEntry } from "../api/client";
import {
  BOOKS_SAVE_CONFLICT_MESSAGE,
  booksSaveErrorText,
} from "moo-family-bookshelf-shared/personal/saveErrors";
import { savedDirtyIds } from "moo-family-bookshelf-shared/personal/savedDirty";
import { overlayShareFlags } from "moo-family-bookshelf-shared/personal/fullPutConflict";
import {
  PERSONAL_BOOKS_CACHE_KEY,
  PERSONAL_SHELF_SAVED_AT_KEY,
} from "../constants";
import { settleSavedShelf } from "./syncedShelf";
import { uploadPersonalShelf, type LandedSave } from "./personalShelfUpload";

export type PersonalBooksStatus =
  "loading" | "ready" | "saving" | "saved" | "error";

const SAVE_FAILED_MESSAGE = "儲存失敗，請稍後再試";

export interface UseSavePersonalShelfParams {
  userId: string;
  apiClient: ApiClient;
  displayName: string;
  books: BookEntry[];
  dirtyBookIds: Set<string>;
  /** The latest committed unsaved-toggle set. */
  dirtyRef: RefObject<Set<string>>;
  /** The list on screen right now; read when a save lands. */
  latestBooksRef: RefObject<BookEntry[]>;
  clearDirtyIds: (bookIds: Iterable<string>) => void;
  setBooks: Dispatch<SetStateAction<BookEntry[]>>;
  /** WRITTEN: the cancel baseline. */
  originalBooks: RefObject<BookEntry[]>;
  /** WRITTEN: the server record as last known. */
  savedRawPayload: RefObject<Record<string, unknown> | null>;
  /** The last applied sync result; compared to spot a mid-save sync. */
  appliedSyncRef: RefObject<BookEntry[] | null>;
  setStatus: Dispatch<SetStateAction<PersonalBooksStatus>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
}

/**
 * The personal shelf's explicit Save — the only path that uploads share
 * changes. Owns the "saved" → "ready" reset timer.
 */
export function useSavePersonalShelf(
  p: UseSavePersonalShelfParams,
): () => Promise<void> {
  const {
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
  } = p;
  /** Pending "saved" → "ready" reset; cleared on unmount and before rescheduling. */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const markSaved = useCallback(() => {
    setStatus("saved");
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setStatus("ready"), 1500);
  }, [setStatus]);

  // Clear only the ids this save really saved: a mid-save toggle stays dirty.
  const commitSaved = useCallback(
    (
      landed: LandedSave,
      sentIds: Set<string>,
      landedSync: BookEntry[] | null,
    ) => {
      const settled = settleSavedShelf({
        books: landed.books,
        usePut: landed.usePut,
        sent: landed.sent,
        serverBooks: savedRawPayload.current?.books,
        landedSync,
      });
      originalBooks.current = settled.baseline;
      const rawBase = landed.usePut ? landed.raw : savedRawPayload.current;
      savedRawPayload.current = { ...rawBase, books: settled.serverBooks };
      void browser.storage.local.set({
        [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(settled.baseline),
      });
      void browser.storage.local.set({
        [PERSONAL_SHELF_SAVED_AT_KEY]: Date.now(),
      });
      if (landed.usePut) {
        // A full PUT wrote every flag: show it on each book not unsaved right now.
        const unsaved = dirtyRef.current;
        setBooks((prev) => overlayShareFlags(prev, settled.baseline, unsaved));
      }
      clearDirtyIds(
        savedDirtyIds(landed.books, latestBooksRef.current, sentIds),
      );
      markSaved();
    },
    [
      savedRawPayload,
      originalBooks,
      dirtyRef,
      setBooks,
      clearDirtyIds,
      latestBooksRef,
      markSaved,
    ],
  );

  return useCallback(async () => {
    // Cancel a pending saved→ready reset: it would drop "saving" / "error".
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);

    // Nothing changed → treat as an instant no-op save (UI guards this too).
    if (dirtyBookIds.size === 0) {
      markSaved();
      return;
    }

    setStatus("saving");
    setErrorMessage("");
    const syncAtStart = appliedSyncRef.current;

    try {
      const result = await uploadPersonalShelf({
        apiClient,
        userId,
        displayName,
        books,
        dirtyBookIds,
        raw: savedRawPayload.current,
      });
      if (!result.ok) {
        setErrorMessage(
          booksSaveErrorText(
            result.error,
            SAVE_FAILED_MESSAGE,
            BOOKS_SAVE_CONFLICT_MESSAGE,
          ),
        );
        setStatus("error");
        return;
      }
      const syncNow = appliedSyncRef.current;
      commitSaved(
        result.landed,
        dirtyBookIds,
        syncNow !== syncAtStart ? syncNow : null,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setStatus("error");
    }
  }, [
    books,
    userId,
    apiClient,
    displayName,
    dirtyBookIds,
    savedRawPayload,
    appliedSyncRef,
    setStatus,
    setErrorMessage,
    markSaved,
    commitSaved,
  ]);
}
