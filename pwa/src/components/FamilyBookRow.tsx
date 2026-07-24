import React from "react";
import { BookOpen } from "lucide-react";
import { BoolFlag } from "@/api/client";
import type { BookEntry } from "@/api/client";
import { FavoriteButton } from "@/components/FavoriteButton";
import { LazyCover } from "@/components/LazyCover";
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu";

export interface FamilyBookRowBook extends BookEntry {
  memberName: string;
  ownerId: string;
  isUpdated: BoolFlag;
}

export interface FamilyBookRowProps {
  book: FamilyBookRowBook;
  showBorrowButton?: boolean;
  borrowRequestPending?: boolean;
  onBorrowClick?: () => void;
  /** Toggle hide/unhide for this copy-scoped card (v1.5.0). */
  onHideToggle?: () => void;
  /** Label for the hide/unhide menu item, e.g. "隱藏書籍" / "取消隱藏". */
  hideActionLabel?: string;
  /** Whether the viewer has favorited this copy-scoped card (v1.5.0). */
  isFavorite?: boolean;
  /** Toggle favorite/unfavorite for this copy-scoped card (v1.5.0). */
  onFavoriteToggle?: () => void;
}

export function FamilyBookRow({
  book,
  showBorrowButton = false,
  borrowRequestPending = false,
  onBorrowClick,
  onHideToggle,
  hideActionLabel,
  isFavorite = false,
  onFavoriteToggle,
}: FamilyBookRowProps) {
  const handleBorrow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!borrowRequestPending && onBorrowClick) onBorrowClick();
  };

  const menuItems: OverflowMenuItem[] = [];
  if (onHideToggle && hideActionLabel) {
    menuItems.push({ label: hideActionLabel, onSelect: onHideToggle });
  }

  return (
    <a
      href={book.readmooUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 py-3 border-b border-gray-100 no-underline text-inherit"
    >
      <div className="relative flex-shrink-0">
        <LazyCover
          src={book.coverUrl}
          alt={book.title}
          className="w-10 h-[54px] rounded object-cover"
          fallback={
            <div className="w-10 h-[54px] rounded bg-gray-100 flex items-center justify-center">
              <BookOpen
                size={18}
                className="text-gray-300"
                aria-hidden="true"
              />
            </div>
          }
        />
        {book.isUpdated === BoolFlag.TRUE && (
          <span
            aria-label="新分享書籍"
            className="absolute -bottom-1 -left-1 bg-green-100 text-green-600 text-[10px] font-semibold px-1 rounded leading-3"
          >
            更新
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] md:text-sm font-medium text-gray-900 truncate">
          {book.title}
        </p>
        <p className="text-xs text-gray-500 truncate">{book.author}</p>
      </div>
      <span className="text-xs text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap">
        {book.memberName}
      </span>
      {showBorrowButton && (
        <button
          type="button"
          onClick={handleBorrow}
          disabled={borrowRequestPending}
          className={`inline-flex items-center text-[11px] font-semibold rounded-full px-2.5 py-1 flex-shrink-0 ${
            borrowRequestPending
              ? "text-gray-400 border border-gray-200 cursor-not-allowed"
              : "text-blue-600 border border-blue-600 hover:bg-blue-50"
          }`}
        >
          {borrowRequestPending ? "申請中" : "申請借閱"}
        </button>
      )}
      {onFavoriteToggle && (
        <span className="flex-shrink-0 inline-flex">
          <FavoriteButton
            isFavorite={isFavorite}
            onFavoriteToggle={onFavoriteToggle}
          />
        </span>
      )}
      {menuItems.length > 0 && (
        <span className="flex-shrink-0">
          <OverflowMenu items={menuItems} />
        </span>
      )}
    </a>
  );
}
