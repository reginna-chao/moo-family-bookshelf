import { useState, useEffect, useCallback, useRef } from "react";

interface UseLoadMoreOptions<T> {
  items: T[];
  pageSize?: number;
  narrowingActive: boolean;
}

interface UseLoadMoreReturn<T> {
  visibleItems: T[];
  hasMore: boolean;
  loadMore: () => void;
  reset: () => void;
}

export function useLoadMore<T>({
  items,
  pageSize = 100,
  narrowingActive,
}: UseLoadMoreOptions<T>): UseLoadMoreReturn<T> {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const prevNarrowingRef = useRef(narrowingActive);

  // Q-C: reset when narrowing filter deactivates (true → false)
  useEffect(() => {
    if (prevNarrowingRef.current && !narrowingActive) {
      setVisibleCount(pageSize);
    }
    prevNarrowingRef.current = narrowingActive;
  }, [narrowingActive, pageSize]);

  const loadMore = useCallback(() => {
    if (!narrowingActive) {
      setVisibleCount((prev) => prev + pageSize);
    }
  }, [narrowingActive, pageSize]);

  const reset = useCallback(() => {
    setVisibleCount(pageSize);
  }, [pageSize]);

  if (narrowingActive) {
    return { visibleItems: items, hasMore: false, loadMore, reset };
  }

  return {
    visibleItems: items.slice(0, visibleCount),
    hasMore: visibleCount < items.length,
    loadMore,
    reset,
  };
}
