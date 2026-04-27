import { useState, useMemo, useCallback } from "react";
import { BookOpen } from "lucide-react";
import { BoolFlag, BorrowStatus } from "@/api/client";
import type { BookEntry } from "@/api/client";
import { useSearch } from "@/hooks/useSearch";
import { useFamilyData, MemberBooks } from "@/hooks/useFamilyData";
import { CategoryFilter, filterByCategory } from "@/components/CategoryFilter";

export interface FamilyShelfPageProps {
  userId: string;
}

interface BookWithMember extends BookEntry {
  memberName: string;
  ownerId: string;
  isUpdated: BoolFlag;
}

type MemberFilterValue = "all" | "all-except-self" | string;

function toBookWithMember(
  member: MemberBooks,
  updatedBookIds: Set<string>,
): BookWithMember[] {
  const name = member.displayName || member.userId.slice(0, 8);
  return member.books.map((b) => ({
    ...b,
    memberName: name,
    ownerId: member.userId,
    isUpdated: updatedBookIds.has(b.bookId) ? BoolFlag.TRUE : BoolFlag.FALSE,
  }));
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
  } = useFamilyData();
  const [filterMember, setFilterMember] =
    useState<MemberFilterValue>("all-except-self");
  const [categoryFilter, setCategoryFilter] = useState("");

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

  const totalBooks = useMemo(
    () => members.reduce((sum, m) => sum + m.books.length, 0),
    [members],
  );

  const memberFilteredBooks = useMemo(() => {
    const toBooks = (m: MemberBooks) => toBookWithMember(m, updatedBookIds);
    if (filterMember === "all") {
      return members.flatMap(toBooks);
    }
    if (filterMember === "all-except-self") {
      return members
        .filter((m) => m.userId !== userId)
        .flatMap(toBooks);
    }
    return members
      .filter((m) => m.userId === filterMember)
      .flatMap(toBooks);
  }, [members, filterMember, userId, updatedBookIds]);

  const categoryFilteredBooks = useMemo(
    () => filterByCategory(memberFilteredBooks, categoryFilter),
    [memberFilteredBooks, categoryFilter],
  );

  const {
    searchTerm,
    setSearchTerm,
    filteredItems: visibleBooks,
    isFiltering,
  } = useSearch(categoryFilteredBooks);

  if (state === "loading") {
    return (
      <div className="p-4 text-center" role="status" aria-label="載入中">
        <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
        <p className="text-gray-500 text-sm mt-3">載入家庭書櫃中...</p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="p-4">
        <p className="text-red-500 text-sm mb-3">{errorMessage}</p>
        <button
          onClick={() => void loadBookshelf()}
          className="px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-600 rounded-lg"
        >
          重試
        </button>
      </div>
    );
  }

  if (totalBooks === 0) {
    return (
      <div className="p-4 text-center">
        <p className="text-gray-400 mt-4">尚無家人分享書籍</p>
        <p className="text-gray-300 text-sm mt-2">
          家庭成員需在「個人書櫃」中開放書籍後才會出現在這裡
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-3">
        家庭開放書櫃
        <span className="text-gray-400 text-sm font-normal ml-2">
          ({totalBooks} 本)
        </span>
      </h2>

      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="搜尋書名或作者"
          aria-label="搜尋書名或作者"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
        />
        <CategoryFilter
          books={memberFilteredBooks}
          value={categoryFilter}
          onChange={setCategoryFilter}
        />
      </div>

      <select
        value={filterMember}
        onChange={(e) => { setFilterMember(e.target.value as MemberFilterValue); setCategoryFilter(""); }}
        aria-label="篩選成員"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-4 bg-white focus:border-blue-500 outline-none"
      >
        <option value="all">所有人的書</option>
        <option value="all-except-self">其他家人的書</option>
        <option value={userId}>自己的書</option>
        {members.filter(m => m.userId !== userId).map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.displayName || m.userId.slice(0, 8)}
          </option>
        ))}
      </select>

      {isFiltering && (
        <p className="text-gray-400 text-xs mb-2">
          找到 {visibleBooks.length} 本
        </p>
      )}

      {visibleBooks.length === 0 ? (
        <p className="text-gray-400 text-sm text-center mt-4">
          {isFiltering ? "找不到符合的書籍" : "目前篩選條件下沒有書籍"}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {visibleBooks.map((book) => {
            const ownerCanLend = memberCanLendMap.get(book.ownerId) ?? true;
            const isOwnBook = book.ownerId === userId;
            const borrowRequestPending = pendingBookIds.has(book.bookId);
            const showBorrowButton =
              !isOwnBook &&
              viewerCanLend &&
              ownerCanLend &&
              !borrowRequestPending &&
              !!apiClient &&
              !!familyId;
            return (
              <div
                key={`${book.memberName}-${book.bookId}`}
                className="block rounded-lg bg-white shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow"
              >
                <a
                  href={book.readmooUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <div className="relative">
                    {book.coverUrl ? (
                      <img
                        src={book.coverUrl}
                        alt={book.title}
                        className="w-full aspect-[3/4] object-cover"
                      />
                    ) : (
                      <div className="w-full aspect-[3/4] bg-gray-100 flex items-center justify-center">
                        <BookOpen size={32} className="text-gray-300" aria-hidden="true" />
                      </div>
                    )}
                    {book.isUpdated === BoolFlag.TRUE && (
                      <span aria-label="新分享書籍" className="absolute bottom-1 left-1 bg-green-100 text-green-600 text-xs font-semibold px-1.5 rounded-full leading-4">
                        更新
                      </span>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {book.title}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{book.author}</p>
                    <p className="text-xs text-blue-500 mt-1 truncate">
                      {book.memberName}
                    </p>
                  </div>
                </a>
                {(showBorrowButton || borrowRequestPending) && !isOwnBook && (
                  <div className="px-2 pb-2">
                    {borrowRequestPending ? (
                      <span className="inline-flex items-center text-[11px] text-gray-400 px-2 py-1">
                        申請已送出
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleBorrowClick(book)}
                        className="inline-flex items-center text-[11px] font-semibold text-blue-600 border border-blue-600 rounded-full px-2.5 py-1 hover:bg-blue-50 transition-colors"
                      >
                        申請借閱
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
