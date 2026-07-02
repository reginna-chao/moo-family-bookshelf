import { BookCard } from "./BookCard";
import { FamilyBookRow } from "./FamilyBookRow";
import type { FamilyShelfBook } from "./useFamilyShelfBooks";

type ViewMode = "grid" | "row";

export interface FamilyShelfBookListProps {
  books: FamilyShelfBook[];
  viewMode: ViewMode;
  userId: string;
  viewerCanLend: boolean;
  memberCanLendMap: Map<string, boolean>;
  pendingBookIds: Set<string>;
  onBorrow: (book: FamilyShelfBook) => void;
  onToggleHidden: (ownerId: string, bookId: string) => void;
  /** Whether a copy-scoped card is currently hidden by the viewer. */
  isHidden: (ownerId: string, bookId: string) => boolean;
  /** Whether a copy-scoped card is favorited by the viewer. */
  isFavorite: (ownerId: string, bookId: string) => boolean;
  /** Toggle a card's favorite state (v1.5.0). */
  onToggleFavorite: (ownerId: string, bookId: string) => void;
}

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(135px, 1fr))",
  gap: 12,
} as const;

/** Renders the family-shelf books in either grid (BookCard) or row layout. */
export function FamilyShelfBookList({
  books,
  viewMode,
  userId,
  viewerCanLend,
  memberCanLendMap,
  pendingBookIds,
  onBorrow,
  onToggleHidden,
  isHidden,
  isFavorite,
  onToggleFavorite,
}: FamilyShelfBookListProps) {
  const renderBook = (book: FamilyShelfBook) => {
    const ownerCanLend = memberCanLendMap.get(book.ownerId) ?? true;
    const isOwnBook = book.ownerId === userId;
    const showBorrowButton = !isOwnBook && viewerCanLend && ownerCanLend;
    const borrowRequestPending = pendingBookIds.has(book.bookId);
    const key = `${book.memberName}-${book.bookId}`;
    const hideActionLabel = isHidden(book.ownerId, book.bookId)
      ? "取消隱藏"
      : "隱藏書籍";
    const shared = {
      book,
      showBorrowButton,
      borrowRequestPending,
      onBorrowClick: () => onBorrow(book),
      onHideToggle: () => onToggleHidden(book.ownerId, book.bookId),
      hideActionLabel,
      isFavorite: isFavorite(book.ownerId, book.bookId),
      onFavoriteToggle: () => onToggleFavorite(book.ownerId, book.bookId),
    };
    if (viewMode === "row") {
      return <FamilyBookRow key={key} {...shared} />;
    }
    return <BookCard key={key} {...shared} />;
  };

  return (
    <div style={viewMode === "grid" ? gridStyle : undefined}>
      {books.map(renderBook)}
    </div>
  );
}
