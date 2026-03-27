import { useState, useMemo, useEffect, useRef } from "react";

interface Searchable {
  title: string;
  author: string;
}

interface UseSearchResult<T> {
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  filteredItems: T[];
  isFiltering: boolean;
}

/**
 * Hook for client-side search with debounce.
 * Performs case-insensitive substring matching on title and author fields.
 */
export function useSearch<T extends Searchable>(
  items: T[],
  debounceMs = 300,
): UseSearchResult<T> {
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setDebouncedTerm(searchTerm);
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [searchTerm, debounceMs]);

  const filteredItems = useMemo(() => {
    const term = debouncedTerm.trim().toLowerCase();
    if (term === "") return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(term) ||
        item.author.toLowerCase().includes(term),
    );
  }, [items, debouncedTerm]);

  const isFiltering = debouncedTerm.trim() !== "";

  return { searchTerm, setSearchTerm, filteredItems, isFiltering };
}
