import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSortMode } from "moo-family-bookshelf-shared/familyShelf/sortBooks";
import {
  readBookSort,
  writeBookSort,
  type BookSortShelf,
} from "../storage/bookSort";

export type { BookSortShelf };

const DEFAULT_SORT: BookSortMode = "default";

export interface UseBookSortReturn {
  sort: BookSortMode;
  setSort: (mode: BookSortMode) => void;
}

export function useBookSort(shelf: BookSortShelf): UseBookSortReturn {
  const [sort, setSortState] = useState<BookSortMode>(DEFAULT_SORT);
  // Set once the user picks a value, so a mount read that resolves later cannot overwrite it.
  const userChoseRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    userChoseRef.current = false; // a choice made on another shelf must not block this shelf's read
    void (async () => {
      try {
        // Legacy values (`title`/`author`) read as their `-asc` form; unrecognized ones as default.
        const stored = await readBookSort(shelf);
        if (!cancelled && !userChoseRef.current) {
          setSortState(stored);
        }
      } catch {
        // storage.local unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shelf]);

  const setSort = useCallback(
    (next: BookSortMode) => {
      if (sort === next) return;
      userChoseRef.current = true;
      setSortState(next);
      // Fire-and-forget, no rollback: direct storage.local writes are reliable here, and losing the
      // persistence beats snapping the choice back under the user.
      void writeBookSort(shelf, next).catch(() => {
        // Ignore write failures; UI state remains authoritative.
      });
    },
    [shelf, sort],
  );

  return { sort, setSort };
}
