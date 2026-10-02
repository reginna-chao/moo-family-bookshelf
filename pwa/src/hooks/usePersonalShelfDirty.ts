import { useState, useCallback } from "react";

export interface UsePersonalShelfDirtyReturn {
  dirtyBookIds: Set<string>;
  isDirty: boolean;
  markDirty: (bookId: string) => void;
  markManyDirty: (bookIds: Iterable<string>) => void;
  clearDirty: () => void;
  /** Clear only `bookIds`; ids marked dirty since stay dirty. */
  clearDirtyIds: (bookIds: Iterable<string>) => void;
}

/** Tracks which books carry unsaved share changes on the personal shelf. */
export function usePersonalShelfDirty(): UsePersonalShelfDirtyReturn {
  const [dirtyBookIds, setDirtyBookIds] = useState<Set<string>>(new Set());
  const isDirty = dirtyBookIds.size > 0;

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

  const clearDirtyIds = useCallback((bookIds: Iterable<string>) => {
    setDirtyBookIds((prev) => {
      const next = new Set(prev);
      for (const id of bookIds) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  return {
    dirtyBookIds,
    isDirty,
    markDirty,
    markManyDirty,
    clearDirty,
    clearDirtyIds,
  };
}
