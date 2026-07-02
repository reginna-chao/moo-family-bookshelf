import { FamilyBookRow } from "@/components/FamilyBookRow";
import { FamilyBookCard } from "@/components/FamilyBookCard";
import type { BookWithMember } from "@/hooks/useFamilyShelfBooks";

type ViewMode = "grid" | "row";

export interface FamilyBookListProps {
  books: BookWithMember[];
  viewMode: ViewMode;
  userId: string;
  viewerCanLend: boolean;
  isFiltering: boolean;
  hasMore: boolean;
  totalFilteredCount: number;
  memberCanLendMap: Map<string, boolean>;
  pendingBookIds: Set<string>;
  canBorrow: boolean;
  onBorrow: (book: BookWithMember) => void;
  onToggleHidden: (ownerId: string, bookId: string) => void;
  /** Whether a copy-scoped card is currently hidden by the viewer. */
  isHidden: (ownerId: string, bookId: string) => boolean;
  /** Whether a copy-scoped card is favorited by the viewer. */
  isFavorite: (ownerId: string, bookId: string) => boolean;
  /** Toggle a card's favorite state (v1.5.0). */
  onToggleFavorite: (ownerId: string, bookId: string) => void;
  onLoadMore: () => void;
}

/** Family-shelf book list (PWA): grid/row layout, empty message, load-more. */
export function FamilyBookList({
  books,
  viewMode,
  userId,
  viewerCanLend,
  isFiltering,
  hasMore,
  totalFilteredCount,
  memberCanLendMap,
  pendingBookIds,
  canBorrow,
  onBorrow,
  onToggleHidden,
  isHidden,
  isFavorite,
  onToggleFavorite,
  onLoadMore,
}: FamilyBookListProps) {
  if (books.length === 0) {
    return (
      <p className="text-gray-400 text-sm text-center mt-4">
        {isFiltering ? "找不到符合的書籍" : "目前篩選條件下沒有書籍"}
      </p>
    );
  }

  const renderBook = (book: BookWithMember) => {
    const ownerCanLend = memberCanLendMap.get(book.ownerId) ?? true;
    const isOwnBook = book.ownerId === userId;
    const borrowRequestPending = pendingBookIds.has(book.bookId);
    const showBorrowButton =
      !isOwnBook &&
      viewerCanLend &&
      ownerCanLend &&
      !borrowRequestPending &&
      canBorrow;
    const key = `${book.memberName}-${book.bookId}`;
    const hideActionLabel = isHidden(book.ownerId, book.bookId)
      ? "取消隱藏"
      : "隱藏書籍";
    const onHideToggle = () => onToggleHidden(book.ownerId, book.bookId);
    const onFavoriteToggle = () => onToggleFavorite(book.ownerId, book.bookId);
    const favorited = isFavorite(book.ownerId, book.bookId);
    if (viewMode === "row") {
      return (
        <FamilyBookRow
          key={key}
          book={book}
          showBorrowButton={showBorrowButton}
          borrowRequestPending={borrowRequestPending}
          onBorrowClick={() => onBorrow(book)}
          onHideToggle={onHideToggle}
          hideActionLabel={hideActionLabel}
          isFavorite={favorited}
          onFavoriteToggle={onFavoriteToggle}
        />
      );
    }
    return (
      <FamilyBookCard
        key={key}
        book={book}
        isOwnBook={isOwnBook}
        showBorrowButton={showBorrowButton}
        borrowRequestPending={borrowRequestPending}
        hideActionLabel={hideActionLabel}
        onBorrowClick={() => onBorrow(book)}
        onHideToggle={onHideToggle}
        isFavorite={favorited}
        onFavoriteToggle={onFavoriteToggle}
      />
    );
  };

  return (
    <>
      <div className={viewMode === "grid" ? "grid grid-cols-2 gap-3" : ""}>
        {books.map(renderBook)}
      </div>

      {hasMore && (
        <button
          onClick={onLoadMore}
          className="w-full py-2.5 mt-3 text-sm font-medium text-blue-600 border border-blue-600 rounded-lg"
        >
          載入更多（已顯示 {books.length} / 共 {totalFilteredCount} 本）
        </button>
      )}
    </>
  );
}
