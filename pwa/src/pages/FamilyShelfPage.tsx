import { useState, useMemo, useCallback } from "react";
import { BoolFlag, BorrowStatus } from "@/api/client";
import { useSearch } from "@/hooks/useSearch";
import { useLoadMore } from "@/hooks/useLoadMore";
import { useFamilyData } from "@/hooks/useFamilyData";
import { filterByCategory } from "@/components/CategoryFilter";
import { useFamilyShelfViewMode } from "@/hooks/useFamilyShelfViewMode";
import { FamilyBookList } from "@/components/FamilyBookList";
import { FamilyShelfToolbar } from "@/components/FamilyShelfToolbar";
import {
  FamilyShelfLoading,
  FamilyShelfError,
  FamilyShelfEmpty,
} from "@/components/FamilyShelfStatus";
import { useBookSort } from "@/hooks/useBookSort";
import { sortBooks } from "@/utils/sortBooks";
import {
  useFamilyShelfBooks,
  type BookWithMember,
  type MemberFilterValue,
} from "@/hooks/useFamilyShelfBooks";

export interface FamilyShelfPageProps {
  userId: string;
}

export function FamilyShelfPage({
  userId,
}: FamilyShelfPageProps) {
  const {
    bookshelfMembers: members,
    bookshelfState: state,
    bookshelfError: errorMessage,
    refreshBookshelf: loadBookshelf,
    updatedBookIds,
    members: familyMembers,
    borrowRequests,
    refreshBorrowRequests,
    apiClient,
    familyId,
    hiddenRefs,
    isHidden,
    toggleHidden,
    favoriteRefs,
    isFavorite,
    toggleFavorite,
    prefsSyncFailed,
  } = useFamilyData();
  const [filterMember, setFilterMember] =
    useState<MemberFilterValue>("all-except-self");
  const [categoryFilter, setCategoryFilter] = useState("");
  const { viewMode, setViewMode } = useFamilyShelfViewMode(userId);
  const { sort, setSort } = useBookSort(userId, "family");

  const memberCanLendMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const m of familyMembers ?? []) {
      // canLend missing/undefined treated as TRUE (backward-compat)
      map.set(m.userId, m.canLend !== BoolFlag.FALSE);
    }
    return map;
  }, [familyMembers]);

  const viewerCanLend = memberCanLendMap.get(userId) ?? true;

  const pendingBookIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of borrowRequests ?? []) {
      if (r.borrowerId === userId && r.status === BorrowStatus.PENDING) {
        set.add(r.bookId);
      }
    }
    return set;
  }, [borrowRequests, userId]);

  const handleBorrowClick = useCallback(
    async (book: BookWithMember) => {
      if (!apiClient || !familyId) return;
      try {
        await apiClient.createBorrowRequest(familyId, {
          bookId: book.bookId,
          bookTitle: book.title,
          bookAuthor: book.author,
          bookCoverUrl: book.coverUrl,
          ownerId: book.ownerId,
        });
        await refreshBorrowRequests?.();
      } catch {
        // Errors surface via the borrow tab; keep family shelf quiet.
      }
    },
    [apiClient, familyId, refreshBorrowRequests],
  );

  const { memberFilteredBooks, totalBooks, headingCount } = useFamilyShelfBooks({
    members,
    filterMember,
    userId,
    updatedBookIds,
    hiddenRefs,
    isHidden,
    favoriteRefs,
    isFavorite,
  });

  const categoryFilteredBooks = useMemo(
    () => filterByCategory(memberFilteredBooks, categoryFilter),
    [memberFilteredBooks, categoryFilter],
  );

  const {
    searchTerm,
    setSearchTerm,
    filteredItems,
    isFiltering,
  } = useSearch(categoryFilteredBooks);

  const sortedBooks = useMemo(() => sortBooks(filteredItems, sort), [filteredItems, sort]);

  const narrowingActive = searchTerm !== "" || categoryFilter !== "";
  const { visibleItems: visibleBooks, hasMore, loadMore, reset: resetLoadMore } = useLoadMore({
    items: sortedBooks,
    narrowingActive,
  });

  const handleMemberFilterChange = useCallback(
    (value: MemberFilterValue) => {
      setFilterMember(value);
      setCategoryFilter("");
      resetLoadMore();
    },
    [resetLoadMore],
  );

  if (state === "loading") {
    return <FamilyShelfLoading />;
  }

  if (state === "error") {
    return (
      <FamilyShelfError
        message={errorMessage}
        onRetry={() => void loadBookshelf()}
      />
    );
  }

  if (totalBooks === 0) {
    return <FamilyShelfEmpty />;
  }

  return (
    <div className="p-4">
      <FamilyShelfToolbar
        headingCount={headingCount}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        categoryBooks={memberFilteredBooks}
        categoryFilter={categoryFilter}
        onCategoryChange={setCategoryFilter}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filterMember={filterMember}
        onMemberFilterChange={handleMemberFilterChange}
        members={members}
        userId={userId}
        sort={sort}
        onSortChange={setSort}
      />

      {prefsSyncFailed && (
        <div
          role="status"
          className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-800"
        >
          ⚠️ 偏好同步失敗，變更已暫存本機，下次操作將自動重試。
        </div>
      )}

      {isFiltering && (
        <p className="text-gray-400 text-xs mb-2">
          找到 {visibleBooks.length} 本
        </p>
      )}

      <FamilyBookList
        books={visibleBooks}
        viewMode={viewMode}
        userId={userId}
        viewerCanLend={viewerCanLend}
        isFiltering={isFiltering}
        hasMore={hasMore}
        totalFilteredCount={filteredItems.length}
        memberCanLendMap={memberCanLendMap}
        pendingBookIds={pendingBookIds}
        canBorrow={!!apiClient && !!familyId}
        onBorrow={(book) => void handleBorrowClick(book)}
        onToggleHidden={toggleHidden}
        isHidden={isHidden}
        isFavorite={isFavorite}
        onToggleFavorite={toggleFavorite}
        onLoadMore={loadMore}
      />
    </div>
  );
}
