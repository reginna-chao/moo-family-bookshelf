import React, { useState, useCallback, useMemo } from "react";
import { BoolFlag, BorrowStatus } from "../api/client";
import { BookCard, BookWithMember } from "./BookCard";
import { FamilyBookRow } from "./FamilyBookRow";
import { MemberDropdown, MemberFilterValue } from "./MemberDropdown";
import { SearchBar } from "./SearchBar";
import { useSearch } from "./useSearch";
import { useLoadMore } from "./useLoadMore";
import { useFamilyData, MemberBooks } from "./FamilyDataContext";
import { CategoryFilter, filterByCategory } from "./CategoryDropdown";
import { LoadingState } from "./LoadingState";
import { useFamilyShelfViewMode } from "./useFamilyShelfViewMode";
import { ViewModeToggle } from "./ViewModeToggle";

export interface FamilyShelfProps {
  userId: string;
}

interface BookOwnership {
  ownerId: string;
}

type FamilyShelfBook = BookWithMember & BookOwnership;

function toBookWithMember(
  member: MemberBooks,
  updatedBookIds: Set<string>,
): FamilyShelfBook[] {
  const name = member.displayName || member.userId.slice(0, 8);
  return member.books.map((b) => ({
    ...b,
    memberName: name,
    ownerId: member.userId,
    isUpdated: updatedBookIds.has(b.bookId) ? BoolFlag.TRUE : BoolFlag.FALSE,
  }));
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
  } = useFamilyData();
  const [filterMember, setFilterMember] = useState<MemberFilterValue>("all-except-self");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const { viewMode, setViewMode } = useFamilyShelfViewMode();

  const totalBooks = members.reduce((sum, m) => sum + m.books.length, 0);

  const memberFilteredBooks = (() => {
    const toBooks = (m: MemberBooks) => toBookWithMember(m, updatedBookIds);
    if (filterMember === "all") {
      return members.flatMap(toBooks);
    }
    if (filterMember === "all-except-self") {
      return members.filter((m) => m.userId !== userId).flatMap(toBooks);
    }
    return members.filter((m) => m.userId === filterMember).flatMap(toBooks);
  })();

  const categoryFilteredBooks = filterByCategory(memberFilteredBooks, categoryFilter);

  const { searchTerm, setSearchTerm, resetSearch, filteredItems, isFiltering } =
    useSearch(categoryFilteredBooks);

  const narrowingActive = searchTerm !== "" || categoryFilter !== "";
  const { visibleItems: visibleBooks, hasMore, loadMore, reset: resetLoadMore } = useLoadMore({
    items: filteredItems,
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
      <div style={{ padding: 16 }}>
        <p style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>
          {errorMessage}
        </p>
        <button
          onClick={() => void loadBookshelf()}
          style={{
            padding: "8px 16px",
            border: "1px solid #2563eb",
            borderRadius: 8,
            background: "transparent",
            color: "#2563eb",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          重試
        </button>
      </div>
    );
  }

  if (totalBooks === 0) {
    return (
      <div style={{ padding: 16, textAlign: "center" }}>
        <p style={{ color: "#94a3b8", marginTop: 16 }}>尚無家人分享書籍</p>
        <p style={{ color: "#cbd5e1", fontSize: 13, marginTop: 8 }}>
          家庭成員需在「個人書櫃」中開放書籍後才會出現在這裡
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
        家庭開放書櫃
        <span
          style={{
            fontWeight: 400,
            color: "#94a3b8",
            marginLeft: 8,
            fontSize: 13,
          }}
        >
          ({totalBooks} 本)
        </span>
      </h3>

      <MemberDropdown
        members={members}
        userId={userId}
        value={filterMember}
        onChange={handleMemberFilterChange}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <SearchBar
            value={searchTerm}
            onChange={setSearchTerm}
            totalCount={categoryFilteredBooks.length}
            filteredCount={visibleBooks.length}
            isFiltering={isFiltering}
          />
        </div>
        <CategoryFilter
          books={memberFilteredBooks}
          value={categoryFilter}
          onChange={setCategoryFilter}
          open={categoryOpen}
          onToggle={() => setCategoryOpen(prev => !prev)}
        />
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>

      <div
        style={
          viewMode === "grid"
            ? {
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: 12,
              }
            : undefined
        }
      >
        {visibleBooks.map((book) => {
          const ownerCanLend = memberCanLendMap.get(book.ownerId) ?? true;
          const isOwnBook = book.ownerId === userId;
          const showBorrowButton = !isOwnBook && viewerCanLend && ownerCanLend;
          const borrowRequestPending = pendingBookIds.has(book.bookId);
          const key = `${book.memberName}-${book.bookId}`;
          const onBorrowClick = () => void handleBorrowClick(book);
          if (viewMode === "row") {
            return (
              <FamilyBookRow
                key={key}
                book={book}
                showBorrowButton={showBorrowButton}
                borrowRequestPending={borrowRequestPending}
                onBorrowClick={onBorrowClick}
              />
            );
          }
          return (
            <BookCard
              key={key}
              book={book}
              showBorrowButton={showBorrowButton}
              borrowRequestPending={borrowRequestPending}
              onBorrowClick={onBorrowClick}
            />
          );
        })}
      </div>

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
