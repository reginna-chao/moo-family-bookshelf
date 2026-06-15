import { useState, useCallback, useMemo } from "react";
import { BoolFlag, BorrowStatus } from "../api/client";
import { HIDDEN_FILTER_VALUE, type MemberFilterValue } from "./MemberDropdown";
import { useSearch } from "./useSearch";
import { useLoadMore } from "./useLoadMore";
import { useFamilyData } from "./FamilyDataContext";
import { filterByCategory } from "./CategoryDropdown";
import { LoadingState } from "./LoadingState";
import { useFamilyShelfViewMode } from "./useFamilyShelfViewMode";
import { useBookSort } from "./useBookSort";
import { sortBooks } from "./sortBooks";
import { useFamilyShelfBooks, type FamilyShelfBook } from "./useFamilyShelfBooks";
import { FamilyShelfBookList } from "./FamilyShelfBookList";
import { FamilyShelfError, FamilyShelfEmpty } from "./FamilyShelfStatus";
import { FamilyShelfToolbar } from "./FamilyShelfToolbar";

export interface FamilyShelfProps {
  userId: string;
}

export function FamilyShelf({ userId }: FamilyShelfProps) {
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
  } = useFamilyData();
  const [filterMember, setFilterMember] = useState<MemberFilterValue>("all-except-self");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const { viewMode, setViewMode } = useFamilyShelfViewMode();
  const { sort, setSort } = useBookSort("family");

  const showHidden = filterMember === HIDDEN_FILTER_VALUE;

  const { memberFilteredBooks, totalBooks, headingCount } = useFamilyShelfBooks({
    members,
    filterMember,
    userId,
    updatedBookIds,
    hiddenRefs,
    isHidden,
  });

  const categoryFilteredBooks = filterByCategory(memberFilteredBooks, categoryFilter);

  const { searchTerm, setSearchTerm, resetSearch, filteredItems, isFiltering } =
    useSearch(categoryFilteredBooks);

  const sortedBooks = useMemo(() => sortBooks(filteredItems, sort), [filteredItems, sort]);

  const narrowingActive = searchTerm !== "" || categoryFilter !== "";
  const { visibleItems: visibleBooks, hasMore, loadMore, reset: resetLoadMore } = useLoadMore({
    items: sortedBooks,
    narrowingActive,
  });

  const handleMemberFilterChange = useCallback((value: MemberFilterValue) => {
    setFilterMember(value);
    setCategoryFilter("");
    setCategoryOpen(false);
    resetSearch();
    resetLoadMore();
  }, [resetSearch, resetLoadMore]);

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

      <FamilyShelfBookList
        books={visibleBooks}
        viewMode={viewMode}
        userId={userId}
        viewerCanLend={viewerCanLend}
        showHidden={showHidden}
        memberCanLendMap={memberCanLendMap}
        pendingBookIds={pendingBookIds}
        onBorrow={(book) => void handleBorrowClick(book)}
        onToggleHidden={toggleHidden}
      />

      {hasMore && (
        <button onClick={loadMore} style={{
          width: "100%", padding: "10px 0", marginTop: 12, border: "1px solid #2563eb",
          borderRadius: 8, background: "transparent", color: "#2563eb",
          fontWeight: 500, fontSize: 13, cursor: "pointer",
        }}>
          載入更多（已顯示 {visibleBooks.length} / 共 {filteredItems.length} 本）
        </button>
      )}
    </div>
  );
}
