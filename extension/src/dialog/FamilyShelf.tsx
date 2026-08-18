import { useState, useCallback, useMemo } from "react";
import { BoolFlag, BorrowStatus } from "../api/client";
import { type MemberFilterValue } from "./MemberDropdown";
import { useSearch } from "./useSearch";
import { useLoadMore } from "./useLoadMore";
import { useFamilyData } from "./FamilyDataContext";
import { filterByCategory } from "./CategoryDropdown";
import { LoadingState } from "./LoadingState";
import { useFamilyShelfViewMode } from "./useFamilyShelfViewMode";
import { useBookSort } from "./useBookSort";
import { sortBooks } from "./sortBooks";
import {
  useFamilyShelfBooks,
  type FamilyShelfBook,
} from "./useFamilyShelfBooks";
import { FamilyShelfBookList } from "./FamilyShelfBookList";
import { FamilyShelfError, FamilyShelfEmpty } from "./FamilyShelfStatus";
import { FamilyShelfToolbar } from "./FamilyShelfToolbar";

export interface FamilyShelfProps {
  userId: string;
  /** Items shown per page in the family shelf list. Injectable for tests; production uses the default. */
  pageSize?: number;
}

/** Subtle, non-blocking banner shown when a prefs flush fails; auto-clears on next success. */
function PrefsSyncFailedNotice() {
  return (
    <div role="status" className="moo-prefs-sync-notice">
      ⚠️ 偏好同步失敗，變更已暫存本機，下次操作將自動重試。
    </div>
  );
}

export function FamilyShelf({ userId, pageSize }: FamilyShelfProps) {
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
  const [categoryOpen, setCategoryOpen] = useState(false);
  const { viewMode, setViewMode } = useFamilyShelfViewMode();
  const { sort, setSort } = useBookSort("family");

  const {
    memberFilteredBooks,
    totalBooks,
    headingCount,
    favoriteCount,
    hiddenCount,
  } = useFamilyShelfBooks({
    members,
    filterMember,
    userId,
    updatedBookIds,
    hiddenRefs,
    isHidden,
    favoriteRefs,
    isFavorite,
  });

  const categoryFilteredBooks = filterByCategory(
    memberFilteredBooks,
    categoryFilter,
  );

  const { searchTerm, setSearchTerm, resetSearch, filteredItems, isFiltering } =
    useSearch(categoryFilteredBooks);

  const sortedBooks = useMemo(
    () => sortBooks(filteredItems, sort),
    [filteredItems, sort],
  );

  const narrowingActive = searchTerm !== "" || categoryFilter !== "";
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

  const handleMemberFilterChange = useCallback(
    (value: MemberFilterValue) => {
      setFilterMember(value);
      setCategoryFilter("");
      setCategoryOpen(false);
      resetSearch();
      resetLoadMore();
    },
    [resetSearch, resetLoadMore],
  );

  const memberCanLendMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const m of familyMembers) {
      // canLend missing/undefined treated as TRUE (backward-compat)
      map.set(m.userId, m.canLend !== BoolFlag.FALSE);
    }
    return map;
  }, [familyMembers]);

  const viewerCanLend = memberCanLendMap.get(userId) ?? true;

  const pendingBookIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of borrowRequests) {
      if (r.borrowerId === userId && r.status === BorrowStatus.PENDING) {
        set.add(r.bookId);
      }
    }
    return set;
  }, [borrowRequests, userId]);

  const handleBorrowClick = useCallback(
    async (book: FamilyShelfBook) => {
      try {
        await apiClient.createBorrowRequest(familyId, {
          bookId: book.bookId,
          bookTitle: book.title,
          bookAuthor: book.author,
          bookCoverUrl: book.coverUrl,
          ownerId: book.ownerId,
        });
        await refreshBorrowRequests();
      } catch {
        // Errors surface via the borrow tab; keep family shelf quiet.
      }
    },
    [apiClient, familyId, refreshBorrowRequests],
  );

  if (state === "loading") {
    return <LoadingState message="載入家庭書櫃中..." />;
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
    <div>
      <FamilyShelfToolbar
        headingCount={headingCount}
        members={members}
        userId={userId}
        filterMember={filterMember}
        onMemberFilterChange={handleMemberFilterChange}
        favoriteCount={favoriteCount}
        hiddenCount={hiddenCount}
        sort={sort}
        onSortChange={setSort}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchTotalCount={categoryFilteredBooks.length}
        searchFilteredCount={visibleBooks.length}
        isFiltering={isFiltering}
        categoryBooks={memberFilteredBooks}
        categoryFilter={categoryFilter}
        onCategoryChange={setCategoryFilter}
        categoryOpen={categoryOpen}
        onCategoryToggle={() => setCategoryOpen((prev) => !prev)}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      {prefsSyncFailed && <PrefsSyncFailedNotice />}

      <FamilyShelfBookList
        books={visibleBooks}
        viewMode={viewMode}
        userId={userId}
        viewerCanLend={viewerCanLend}
        memberCanLendMap={memberCanLendMap}
        pendingBookIds={pendingBookIds}
        onBorrow={(book) => void handleBorrowClick(book)}
        onToggleHidden={toggleHidden}
        isHidden={isHidden}
        isFavorite={isFavorite}
        onToggleFavorite={toggleFavorite}
      />

      {hasMore && (
        <button
          onClick={loadMore}
          className="moo-button moo-button--outline moo-load-more"
        >
          載入更多（已顯示 {visibleBooks.length} / 共 {filteredItems.length}{" "}
          本）
        </button>
      )}
    </div>
  );
}
