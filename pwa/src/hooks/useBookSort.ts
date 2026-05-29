import { useCallback, useEffect, useState } from "react";
import type { BookSortMode } from "@/utils/sortBooks";
import { namespacedKey } from "@/hooks/useAuth";

export type BookSortShelf = "family" | "personal";

function isSortMode(value: unknown): value is BookSortMode {
  return value === "default" || value === "title" || value === "author";
}

function readSort(storageKey: string): BookSortMode {
  const stored = localStorage.getItem(storageKey);
  return isSortMode(stored) ? stored : "default";
}

export interface UseBookSortReturn {
  sort: BookSortMode;
  setSort: (mode: BookSortMode) => void;
}

export function useBookSort(userId: string, shelf: BookSortShelf): UseBookSortReturn {
  const storageKey = namespacedKey(
    userId,
    shelf === "family" ? "familyShelfSort" : "personalShelfSort",
  );

  const [sort, setSortState] = useState<BookSortMode>(() => readSort(storageKey));

  useEffect(() => {
    setSortState(readSort(storageKey));
  }, [storageKey]);

  const setSort = useCallback(
    (mode: BookSortMode) => {
      localStorage.setItem(storageKey, mode);
      setSortState(mode);
    },
    [storageKey],
  );

  return { sort, setSort };
}
