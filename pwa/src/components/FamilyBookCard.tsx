import { BookOpen } from "lucide-react";
import { BoolFlag } from "@/api/client";
import { FavoriteButton } from "@/components/FavoriteButton";
import { LazyCover } from "@/components/LazyCover";
import { OverflowMenu } from "@/components/OverflowMenu";
import type { BookWithMember } from "@/hooks/useFamilyShelfBooks";

export interface FamilyBookCardProps {
  book: BookWithMember;
  isOwnBook: boolean;
  showBorrowButton: boolean;
  borrowRequestPending: boolean;
  hideActionLabel: string;
  /** Whether the viewer has favorited this copy-scoped card (v1.5.0). */
  isFavorite: boolean;
  onBorrowClick: () => void;
  onHideToggle: () => void;
  /** Toggle favorite/unfavorite for this copy-scoped card (v1.5.0). */
  onFavoriteToggle: () => void;
}

function BorrowControl({
  isOwnBook,
  showBorrowButton,
  borrowRequestPending,
  onBorrowClick,
}: Pick<
  FamilyBookCardProps,
  "isOwnBook" | "showBorrowButton" | "borrowRequestPending" | "onBorrowClick"
>) {
  if (isOwnBook) return null;
  if (borrowRequestPending) {
    return (
      <span className="inline-flex items-center text-[11px] text-gray-400 px-2 py-1">
        申請已送出
      </span>
    );
  }
  if (!showBorrowButton) return null;
  return (
    <button
      type="button"
      onClick={onBorrowClick}
      className="inline-flex items-center text-[11px] font-semibold text-blue-600 border border-blue-600 rounded-full px-2.5 py-1 hover:bg-blue-50 transition-colors"
    >
      申請借閱
    </button>
  );
}

/** Grid-layout family-shelf book card (PWA). */
export function FamilyBookCard({
  book,
  isOwnBook,
  showBorrowButton,
  borrowRequestPending,
  hideActionLabel,
  isFavorite,
  onBorrowClick,
  onHideToggle,
  onFavoriteToggle,
}: FamilyBookCardProps) {
  return (
    <div className="block rounded-lg bg-white shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow">
      <a
        href={book.readmooUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <div className="relative">
          <LazyCover
            src={book.coverUrl}
            alt={book.title}
            className="w-full aspect-[3/4] object-cover"
            fallback={
              <div className="w-full aspect-[3/4] bg-gray-100 flex items-center justify-center">
                <BookOpen size={32} className="text-gray-300" aria-hidden="true" />
              </div>
            }
          />
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
      <div className="flex items-center gap-2 px-2 pb-2">
        <BorrowControl
          isOwnBook={isOwnBook}
          showBorrowButton={showBorrowButton}
          borrowRequestPending={borrowRequestPending}
          onBorrowClick={onBorrowClick}
        />
        <div className="ml-auto flex items-center gap-1">
          <FavoriteButton isFavorite={isFavorite} onFavoriteToggle={onFavoriteToggle} />
          <OverflowMenu items={[{ label: hideActionLabel, onSelect: onHideToggle }]} />
        </div>
      </div>
    </div>
  );
}
