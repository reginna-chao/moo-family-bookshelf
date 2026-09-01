import React from "react";
import { BoolFlag } from "../api/client";
import type { BookWithMember } from "./BookCard";
import { FavoriteButton } from "./FavoriteButton";
import { LazyCover } from "./LazyCover";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";
import { safeBookUrl } from "./safeBookUrl";
import { safeCoverUrl } from "./safeCoverUrl";

export interface FamilyBookRowProps {
  book: BookWithMember;
  showBorrowButton?: boolean;
  onBorrowClick?: () => void;
  borrowRequestPending?: boolean;
  /** Toggle hide/unhide for this copy-scoped card (v1.5.0). */
  onHideToggle?: () => void;
  /** Label for the hide/unhide menu item, e.g. "隱藏書籍" / "取消隱藏". */
  hideActionLabel?: string;
  /** Whether the viewer has favorited this copy-scoped card (v1.5.0). */
  isFavorite?: boolean;
  /** Toggle favorite/unfavorite for this copy-scoped card (v1.5.0). */
  onFavoriteToggle?: () => void;
  /** On mobile, stack the owner badge below the author instead of as a sibling. */
  isMobile?: boolean;
}

export function FamilyBookRow({
  book,
  showBorrowButton = false,
  onBorrowClick,
  borrowRequestPending = false,
  onHideToggle,
  hideActionLabel,
  isFavorite = false,
  onFavoriteToggle,
  isMobile = false,
}: FamilyBookRowProps) {
  const menuItems: OverflowMenuItem[] = [];
  if (onHideToggle && hideActionLabel) {
    menuItems.push({ label: hideActionLabel, onSelect: onHideToggle });
  }
  const handleBorrow = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!borrowRequestPending && onBorrowClick) onBorrowClick();
  };

  const borrowBtnClass = borrowRequestPending
    ? "moo-button moo-button--xs moo-book-row__borrow-btn moo-book-row__borrow-btn--pending"
    : "moo-button moo-button--xs moo-book-row__borrow-btn";

  return (
    <a
      href={safeBookUrl(book.readmooUrl) || undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="moo-book-row"
    >
      <div className="moo-book-row__cover-wrap">
        <LazyCover
          src={safeCoverUrl(book.coverUrl)}
          alt={book.title}
          width={40}
          height={60}
          className="moo-book-row__cover"
          fallback={<div className="moo-book-row__cover-fallback" />}
        />
        {book.isUpdated === BoolFlag.TRUE && (
          <span aria-label="新分享書籍" className="moo-book-row__updated-badge">
            更新
          </span>
        )}
      </div>
      <div className="moo-book-row__info">
        <div
          className={
            isMobile
              ? "moo-book-row__title moo-book-row__title--mobile"
              : "moo-book-row__title"
          }
        >
          {book.title}
        </div>
        {book.author && (
          <div className="moo-book-row__author">{book.author}</div>
        )}
        {isMobile && (
          <span className="moo-book-row__member moo-book-row__member--stacked">
            {book.memberName}
          </span>
        )}
      </div>
      {!isMobile && (
        <span className="moo-book-row__member">{book.memberName}</span>
      )}
      {showBorrowButton && (
        <button
          type="button"
          disabled={borrowRequestPending}
          onClick={handleBorrow}
          className={borrowBtnClass}
        >
          {borrowRequestPending ? "申請中" : "申請借閱"}
        </button>
      )}
      {onFavoriteToggle && (
        <span className="moo-book-row__favorite">
          <FavoriteButton
            isFavorite={isFavorite}
            onFavoriteToggle={onFavoriteToggle}
          />
        </span>
      )}
      {menuItems.length > 0 && (
        <span className="moo-book-row__menu">
          <OverflowMenu items={menuItems} tone="plain" />
        </span>
      )}
    </a>
  );
}
