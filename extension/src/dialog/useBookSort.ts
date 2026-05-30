import { useCallback, useEffect, useRef, useState } from "react";
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
    chrome.runtime.sendMessage(
      { type: "GET_BOOK_SORT", shelf },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (isSortMode(response?.sort)) {
          setSortState(response.sort);
        }
      },
    );
  }, [shelf]);

  const setSort = useCallback(
    (next: BookSortMode) => {
      const prev = sortRef.current;
      if (prev === next) return;
      setSortState(next);
      chrome.runtime.sendMessage(
        { type: "SET_BOOK_SORT", shelf, sort: next },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            setSortState(prev);
          }
        },
      );
    },
    [shelf],
  );

  return { sort, setSort };
}
