import React, { useState, useCallback } from "react";
import { BookCard, BookWithMember } from "./BookCard";
import { MemberDropdown, MemberFilterValue } from "./MemberDropdown";
import { SearchBar } from "./SearchBar";
import { useSearch } from "./useSearch";
import { useFamilyData, MemberBooks } from "./FamilyDataContext";
import { CategoryFilter, filterByCategory } from "./CategoryDropdown";

export interface FamilyShelfProps {
  userId: string;
}

function toBookWithMember(member: MemberBooks): BookWithMember[] {
  const name = member.displayName || member.userId.slice(0, 8);
  return member.books.map((b) => ({ ...b, memberName: name }));
}

export function FamilyShelf({ userId }: FamilyShelfProps) {
  const {
    bookshelfMembers: members,
    bookshelfState: state,
    bookshelfError: errorMessage,
    refreshBookshelf: loadBookshelf,
  } = useFamilyData();
  const [filterMember, setFilterMember] = useState<MemberFilterValue>("all-except-self");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);

  const totalBooks = members.reduce((sum, m) => sum + m.books.length, 0);

  const memberFilteredBooks = (() => {
    if (filterMember === "all") {
      return members.flatMap(toBookWithMember);
    }
    if (filterMember === "all-except-self") {
      return members.filter((m) => m.userId !== userId).flatMap(toBookWithMember);
    }
    return members.filter((m) => m.userId === filterMember).flatMap(toBookWithMember);
  })();

  const categoryFilteredBooks = filterByCategory(memberFilteredBooks, categoryFilter);

  const { searchTerm, setSearchTerm, resetSearch, filteredItems: visibleBooks, isFiltering } =
    useSearch(categoryFilteredBooks);

  const handleMemberFilterChange = useCallback((value: MemberFilterValue) => {
    setFilterMember(value);
    setCategoryFilter("");
    setCategoryOpen(false);
    resetSearch();
  }, [resetSearch]);

  if (state === "loading") {
    return (
      <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>
        載入家庭書櫃中...
      </div>
    );
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
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
          gap: 12,
        }}
      >
        {visibleBooks.map((book) => (
          <BookCard key={`${book.memberName}-${book.bookId}`} book={book} />
        ))}
      </div>
    </div>
  );
}
