import { useEffect, useCallback, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { PERSONAL_BOOKS_SCHEMA_VERSION } from "@/api/client";
import type { ApiClient, BookEntry } from "@/api/client";
import {
  applyPatchChanges,
  decideSaveStrategy,
} from "moo-family-bookshelf-shared/personal/saveStrategy";
import { booksSaveErrorText } from "moo-family-bookshelf-shared/personal/saveErrors";
import { useFamilyData } from "@/hooks/useFamilyData";

/** Backend rejects PATCH `changes` arrays longer than this; fall back to PUT. */
const MAX_PATCH_CHANGES = 1000;

export type LoadState = "loading" | "ready" | "saving" | "saved" | "error";

export interface UsePersonalShelfSaveOptions {
  userId: string;
  apiClient: ApiClient;
  displayName: string;
  books: BookEntry[];
  dirtyBookIds: Set<string>;
  clearDirty: () => void;
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
  dirtyBookIds,
  clearDirty,
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

  const handleSave = useCallback(async () => {
    // A new save supersedes any pending saved→ready reset: letting the old timer
    // fire mid-flight would drop `state` out of "saving" (and out of "error").
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);

    // Nothing changed → treat as an instant no-op save (UI guards this too).
    if (dirtyBookIds.size === 0) {
      setState("saved");
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setState("ready"), 1500);
      return;
    }

    setState("saving");

    // PATCH `patchChanges` (dirty books, server-only unshares)
    // unless the diff can't be safely expressed as a partial update — those
    // fall back to a full PUT so nothing is silently dropped (see saveStrategy).
    const { usePut, patchChanges } = decideSaveStrategy({
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
        : await apiClient.patchPersonalBooks(userId, patchChanges);
      if (response.error) {
        setErrorMessage(
          booksSaveErrorText(response.error, "儲存失敗，請稍後再試"),
        );
        setState("error");
        return;
      }
      originalBooksRef.current = books;
      // Only a PUT persists the full local list; a PATCH leaves the server's
      // book set unchanged (it can only update isShared of existing books), so
      // it only folds the sent flags into the snapshot. Marking PATCH-time
      // books as server-known would wrongly classify un-synced scraped books
      // as known and silently drop them on a later PATCH.
      const prev = savedRawPayload.current ?? {};
      const next = usePut ? books : applyPatchChanges(prev.books, patchChanges);
      savedRawPayload.current = { ...prev, books: next };
      clearDirty();
      setState("saved");
      // Refresh the aggregated family bookshelf so it reflects the saved shares
      void refreshBookshelf();
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setState("ready"), 1500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "儲存失敗");
      setState("error");
    }
  }, [
    userId,
    displayName,
    books,
    apiClient,
    clearDirty,
    dirtyBookIds,
    refreshBookshelf,
    originalBooksRef,
    savedRawPayload,
    setState,
    setErrorMessage,
  ]);

  return handleSave;
}
