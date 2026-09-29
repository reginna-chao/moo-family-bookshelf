import { BookRow } from "@/components/BookRow";
import type { BookEntry } from "@/api/client";

export interface PersonalShelfBookListProps {
  visibleBooks: BookEntry[];
  isFiltering: boolean;
  allVisibleSelected: boolean;
  onSelectAll: () => void;
  selectedIds: Set<string>;
  dirtyBookIds: Set<string>;
  onSelect: (bookId: string) => void;
  onToggle: (bookId: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  totalFilteredBookCount: number;
}

/** Select-all row, match count, book rows and "load more" (PWA personal shelf). */
export function PersonalShelfBookList({
  visibleBooks,
  isFiltering,
  allVisibleSelected,
  onSelectAll,
  selectedIds,
  dirtyBookIds,
  onSelect,
  onToggle,
  hasMore,
  onLoadMore,
  totalFilteredBookCount,
}: PersonalShelfBookListProps) {
  return (
    <>
      {visibleBooks.length > 0 && (
        <div className="flex items-center justify-between mb-2">
          {isFiltering && (
            <p className="text-gray-400 text-xs">
              找到 {visibleBooks.length} 本
            </p>
          )}
          <button
            onClick={onSelectAll}
            className="text-xs text-blue-600 hover:text-blue-800 ml-auto"
          >
            {allVisibleSelected ? "取消全選" : "全選"}
          </button>
        </div>
      )}

      {isFiltering && visibleBooks.length === 0 && (
        <p className="text-gray-400 text-xs mb-2">
          找到 {visibleBooks.length} 本
        </p>
      )}

      {visibleBooks.length === 0 ? (
        <p className="text-gray-400 text-sm text-center mt-4">
          {isFiltering ? "找不到符合的書籍" : "目前篩選條件下沒有書籍"}
        </p>
      ) : (
        <>
          <div>
            {visibleBooks.map((book) => (
              <BookRow
                key={book.bookId}
                book={book}
                selected={selectedIds.has(book.bookId)}
                isDirty={dirtyBookIds.has(book.bookId)}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
          </div>

          {hasMore && (
            <button
              onClick={onLoadMore}
              className="w-full py-2.5 mt-3 text-sm font-medium text-blue-600 border border-blue-600 rounded-lg"
            >
              載入更多（已顯示 {visibleBooks.length} / 共{" "}
              {totalFilteredBookCount} 本）
            </button>
          )}
        </>
      )}
    </>
  );
}
