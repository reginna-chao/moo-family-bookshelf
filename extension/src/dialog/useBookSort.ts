import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import type { BookSortMode } from "./sortBooks";

export type BookSortShelf = "family" | "personal";

const DEFAULT_SORT: BookSortMode = "default";

function isSortMode(value: unknown): value is BookSortMode {
  return value === "default" || value === "title" || value === "author";
}

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
        if (isSortMode(response?.sort)) {
          setSortState(response.sort);
        }
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
