import { useState, useCallback, useRef } from "react";
import type { RenamedBook } from "../sync/renamedBooks";
import { moveRenamedDirtyIds } from "./syncedShelf";

/**
 * The personal shelf's unsaved-toggle set: ids whose `isShared` the user
 * changed and has not saved yet. `dirtyRef` mirrors the latest committed set
 * for effects that must not depend on it.
 */
export function useDirtyBookIds() {
  const [dirtyBookIds, setDirtyBookIds] = useState<Set<string>>(
    () => new Set(),
  );
  const dirtyRef = useRef(dirtyBookIds);
  dirtyRef.current = dirtyBookIds;

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

  /** Clear only `bookIds`; ids marked dirty since stay dirty. */
  const clearDirtyIds = useCallback((bookIds: Iterable<string>) => {
    setDirtyBookIds((prev) => {
      const next = new Set(prev);
      for (const id of bookIds) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  /** A sync moved books to new ids: a dirty old id becomes its dirty new id. */
  const moveRenamedDirty = useCallback((renamed: readonly RenamedBook[]) => {
    if (renamed.length === 0) return;
    setDirtyBookIds((prev) => moveRenamedDirtyIds(prev, renamed));
  }, []);

  return {
    dirtyBookIds,
    dirtyRef,
    markDirty,
    markManyDirty,
    clearDirty,
    clearDirtyIds,
    moveRenamedDirty,
  };
}
