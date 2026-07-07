import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import type { BookSortMode } from "./sortBooks";
import { normalizeSortMode } from "./sortBooks";

export type BookSortShelf = "family" | "personal";

const DEFAULT_SORT: BookSortMode = "default";

export interface UseBookSortReturn {
  sort: BookSortMode;
  setSort: (mode: BookSortMode) => void;
}

export function useBookSort(shelf: BookSortShelf): UseBookSortReturn {
  const [sort, setSortState] = useState<BookSortMode>(DEFAULT_SORT);
  const sortRef = useRef(sort);

  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GET_BOOK_SORT",
          shelf,
        })) as { sort?: unknown } | undefined;
        if (cancelled) return;
        // Background may return a legacy value (`title`/`author`); normalize to
        // the canonical `-asc` form before applying so stored preferences carry
        // over without a migration. Unrecognized values normalize to default.
        setSortState(normalizeSortMode(response?.sort));
      } catch {
        // Background unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shelf]);

  const setSort = useCallback(
    (next: BookSortMode) => {
      const prev = sortRef.current;
      if (prev === next) return;
      setSortState(next);
      void (async () => {
        try {
          const response = (await browser.runtime.sendMessage({
            type: "SET_BOOK_SORT",
            shelf,
            sort: next,
          })) as { ok?: boolean } | undefined;
          if (!response?.ok) {
            setSortState(prev);
          }
        } catch {
          setSortState(prev);
        }
      })();
    },
    [shelf],
  );

  return { sort, setSort };
}
