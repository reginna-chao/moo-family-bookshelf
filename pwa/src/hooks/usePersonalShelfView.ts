import { useState, useCallback, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { BoolFlag } from "@/api/client";
import type { BookEntry } from "@/api/client";
import { filterByCategory } from "@/components/CategoryFilter";
import { namespacedKey } from "@/hooks/useAuth";
import { useSearch } from "@/hooks/useSearch";
import { useLoadMore } from "@/hooks/useLoadMore";
import { sortBooks } from "moo-family-bookshelf-shared/familyShelf/sortBooks";
import type { BookSortMode } from "moo-family-bookshelf-shared/familyShelf/sortBooks";

export type StatusFilter = "all" | "shared" | "not-shared";
export type ArchiveView = "active" | "archived";

export interface UsePersonalShelfViewOptions {
  userId: string;
  books: BookEntry[];
  sort: BookSortMode;
  pageSize?: number;
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
}

/**
 * Personal-shelf view pipeline: archive tab → status filter → category →
 * search → sort → pagination, plus select-all over the visible page.
 */
export function usePersonalShelfView({
  userId,
  books,
  sort,
  pageSize,
  selectedIds,
  setSelectedIds,
}: UsePersonalShelfViewOptions) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [archiveView, setArchiveView] = useState<ArchiveView>("active");

  const syncArchived =
    localStorage.getItem(namespacedKey(userId, "syncArchived")) === "1";
  const activeBooks = useMemo(
    () => books.filter((b) => b.isArchived !== BoolFlag.TRUE),
    [books],
  );
  const archivedBooks = useMemo(
    () => books.filter((b) => b.isArchived === BoolFlag.TRUE),
    [books],
  );
  const showArchiveTabs = syncArchived && archivedBooks.length > 0;
  const currentViewBooks =
    showArchiveTabs && archiveView === "archived" ? archivedBooks : activeBooks;

  const statusFilteredBooks = useMemo(() => {
    if (statusFilter === "shared")
      return currentViewBooks.filter((b) => b.isShared === BoolFlag.TRUE);
    if (statusFilter === "not-shared")
      return currentViewBooks.filter((b) => b.isShared === BoolFlag.FALSE);
    return currentViewBooks;
  }, [currentViewBooks, statusFilter]);

  const categoryFilteredBooks = useMemo(
    () => filterByCategory(statusFilteredBooks, categoryFilter),
    [statusFilteredBooks, categoryFilter],
  );

  const { searchTerm, setSearchTerm, filteredItems, isFiltering } = useSearch(
    categoryFilteredBooks,
  );

  const sortedBooks = useMemo(
    () => sortBooks(filteredItems, sort),
    [filteredItems, sort],
  );

  const narrowingActive =
    searchTerm !== "" || statusFilter !== "all" || categoryFilter !== "";
  const {
    visibleItems: visibleBooks,
    hasMore,
    loadMore,
    reset: resetLoadMore,
  } = useLoadMore({
    items: sortedBooks,
    narrowingActive,
    pageSize,
  });

  const selectArchiveView = (view: ArchiveView) => {
    setArchiveView(view);
    setCategoryFilter("");
    resetLoadMore();
  };

  const selectStatusFilter = (f: StatusFilter) => {
    setStatusFilter(f);
    setCategoryFilter("");
  };

  const handleSelectAll = useCallback(() => {
    const allVisible = visibleBooks.every((b) => selectedIds.has(b.bookId));
    if (allVisible && visibleBooks.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleBooks.map((b) => b.bookId)));
    }
  }, [visibleBooks, selectedIds, setSelectedIds]);

  const allVisibleSelected =
    visibleBooks.length > 0 &&
    visibleBooks.every((b) => selectedIds.has(b.bookId));

  return {
    activeBooks,
    archivedBooks,
    showArchiveTabs,
    currentViewBooks,
    archiveView,
    selectArchiveView,
    statusFilter,
    selectStatusFilter,
    categoryFilter,
    setCategoryFilter,
    statusFilteredBooks,
    searchTerm,
    setSearchTerm,
    filteredItems,
    isFiltering,
    visibleBooks,
    hasMore,
    loadMore,
    handleSelectAll,
    allVisibleSelected,
  };
}
