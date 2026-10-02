import { useEffect, useCallback, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ApiClient, BookEntry } from "@/api/client";
import { applyPatchChanges } from "moo-family-bookshelf-shared/personal/saveStrategy";
import {
  BOOKS_SAVE_CONFLICT_MESSAGE,
  booksSaveErrorText,
} from "moo-family-bookshelf-shared/personal/saveErrors";
import { savedDirtyIds } from "moo-family-bookshelf-shared/personal/savedDirty";
import { overlayShareFlags } from "moo-family-bookshelf-shared/personal/fullPutConflict";
import { useFamilyData } from "@/hooks/useFamilyData";
import {
  uploadPersonalShelf,
  type LandedSave,
} from "@/hooks/personalShelfUpload";

export type LoadState = "loading" | "ready" | "saving" | "saved" | "error";

export interface UsePersonalShelfSaveOptions {
  userId: string;
  apiClient: ApiClient;
  displayName: string;
  books: BookEntry[];
  setBooks: Dispatch<SetStateAction<BookEntry[]>>;
  /** The list on screen right now; read when a save lands. */
  latestBooksRef: RefObject<BookEntry[]>;
  dirtyBookIds: Set<string>;
  /** The latest committed unsaved-toggle set; read when a save lands. */
  dirtyRef: RefObject<Set<string>>;
  clearDirtyIds: (bookIds: Iterable<string>) => void;
  originalBooksRef: RefObject<BookEntry[]>;
  savedRawPayload: RefObject<Record<string, unknown> | null>;
  setState: Dispatch<SetStateAction<LoadState>>;
  setErrorMessage: Dispatch<SetStateAction<string>>;
}

/**
 * The personal shelf's explicit Save action — the only path that uploads
 * share changes. Owns the "saved" → "ready" reset timer.
 */
export function usePersonalShelfSave({
  userId,
  apiClient,
  displayName,
  books,
  setBooks,
  latestBooksRef,
  dirtyBookIds,
  dirtyRef,
  clearDirtyIds,
  originalBooksRef,
  savedRawPayload,
  setState,
  setErrorMessage,
}: UsePersonalShelfSaveOptions): () => Promise<void> {
  const { refreshBookshelf } = useFamilyData();
  /** Pending "saved" → "ready" reset; cleared on unmount and before rescheduling. */
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const markSaved = useCallback(() => {
    setState("saved");
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setState("ready"), 1500);
  }, [setState]);

  // Fold a landed save into the snapshot, baseline and screen.
  const commitSaved = useCallback(
    (landed: LandedSave, sentIds: Set<string>) => {
      originalBooksRef.current = landed.books;
      if (landed.usePut) {
        savedRawPayload.current = { ...landed.raw, books: landed.books };
        // A full PUT wrote every flag: show it on each book not unsaved right now.
        const unsaved = dirtyRef.current;
        setBooks((prev) => overlayShareFlags(prev, landed.books, unsaved));
      } else {
        // A PATCH never adds books: marking un-synced books server-known would
        // drop them on a later PATCH, so only the sent flags are folded in.
        const prev = savedRawPayload.current ?? {};
        const next = applyPatchChanges(prev.books, landed.patchChanges);
        savedRawPayload.current = { ...prev, books: next };
      }
      // Clear only the ids this save really saved: a mid-save toggle stays dirty.
      clearDirtyIds(
        savedDirtyIds(landed.books, latestBooksRef.current, sentIds),
      );
      markSaved();
      // Refresh the aggregated family bookshelf so it reflects the saved shares
      void refreshBookshelf();
    },
    [
      originalBooksRef,
      savedRawPayload,
      dirtyRef,
      setBooks,
      clearDirtyIds,
      latestBooksRef,
      markSaved,
      refreshBookshelf,
    ],
  );

  const handleSave = useCallback(async () => {
    // A new save supersedes any pending saved→ready reset: letting the old timer
    // fire mid-flight would drop `state` out of "saving" (and out of "error").
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);

    // Nothing changed → treat as an instant no-op save (UI guards this too).
    if (dirtyBookIds.size === 0) {
      markSaved();
      return;
    }

    setState("saving");

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
            "儲存失敗，請稍後再試",
            BOOKS_SAVE_CONFLICT_MESSAGE,
          ),
        );
        setState("error");
        return;
      }
      commitSaved(result.landed, dirtyBookIds);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setState("error");
    }
  }, [
    userId,
    displayName,
    books,
    apiClient,
    dirtyBookIds,
    savedRawPayload,
    markSaved,
    commitSaved,
    setState,
    setErrorMessage,
  ]);

  return handleSave;
}
