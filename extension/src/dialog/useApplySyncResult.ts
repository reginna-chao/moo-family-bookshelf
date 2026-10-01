import {
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { BookEntry } from "../api/client";
import type { RenamedBook } from "../sync/renamedBooks";
import { reconcileSyncedShelf } from "./syncedShelf";

export interface UseApplySyncResultParams {
  /** WRITTEN: the last applied result — each result is applied exactly once. */
  appliedSyncRef: RefObject<BookEntry[] | null>;
  /** The last successful sync's list; `[]` = no sync yet. */
  lastSyncBooks: BookEntry[];
  /** Books that same sync moved to a new Readmoo id. */
  lastSyncRenamedBooks: readonly RenamedBook[];
  /** The initial load has finished; a result is never applied before it. */
  loaded: boolean;
  setBooks: Dispatch<SetStateAction<BookEntry[]>>;
  /** The latest committed unsaved-toggle set. */
  dirtyRef: RefObject<Set<string>>;
  moveRenamedDirty: (renamed: readonly RenamedBook[]) => void;
  /** WRITTEN: becomes the sync result (the cancel baseline). */
  originalBooks: RefObject<BookEntry[]>;
  /** WRITTEN: its `books` becomes the sync result (the server snapshot). */
  savedRawPayload: RefObject<Record<string, unknown> | null>;
}

/**
 * Apply each successful sync result to the personal shelf, exactly once and
 * only after load. The result is what the server now holds, so it REPLACES
 * the list (a book whose Readmoo id changed must leave the screen, or a later
 * PUT would write the old id back). Display keeps the local flag of every
 * unsaved toggle, moved to the new id of a renamed book (Invariant 3); the
 * cancel baseline and the server snapshot become the sync result.
 */
export function useApplySyncResult({
  appliedSyncRef,
  lastSyncBooks,
  lastSyncRenamedBooks,
  loaded,
  setBooks,
  dirtyRef,
  moveRenamedDirty,
  originalBooks,
  savedRawPayload,
}: UseApplySyncResultParams): void {
  useEffect(() => {
    if (lastSyncBooks.length === 0 || !loaded) return;
    if (appliedSyncRef.current === lastSyncBooks) return;
    appliedSyncRef.current = lastSyncBooks;
    const dirtyAtSync = dirtyRef.current;
    setBooks(
      (prev) =>
        reconcileSyncedShelf(
          lastSyncBooks,
          prev,
          dirtyAtSync,
          lastSyncRenamedBooks,
        ).books,
    );
    moveRenamedDirty(lastSyncRenamedBooks);
    originalBooks.current = lastSyncBooks;
    savedRawPayload.current = {
      ...savedRawPayload.current,
      books: lastSyncBooks,
    };
  }, [
    appliedSyncRef,
    lastSyncBooks,
    lastSyncRenamedBooks,
    loaded,
    setBooks,
    dirtyRef,
    moveRenamedDirty,
    originalBooks,
    savedRawPayload,
  ]);
}
