import React from "react";
import { BookEntry, BoolFlag } from "../api/client";
import { FavoriteButton } from "./FavoriteButton";
import { LazyCover } from "./LazyCover";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";
import { safeCoverUrl } from "./safeCoverUrl";

export interface BookWithMember extends BookEntry {
  memberName: string;
  isUpdated: BoolFlag;
}

export interface BookCardProps {
  book: BookWithMember;
  /** Show the "申請借閱" action button (FamilyShelf context only). */
  showBorrowButton?: boolean;
  /** Triggered when user clicks the borrow button. */
  onBorrowClick?: () => void;
  /** Disables the borrow button (e.g. an existing PENDING request). */
  borrowRequestPending?: boolean;
  /** Toggle hide/unhide for this copy-scoped card (v1.5.0). */
  onHideToggle?: () => void;
  /** Label for the hide/unhide menu item, e.g. "隱藏書籍" / "取消隱藏". */
  hideActionLabel?: string;
  /** Whether the viewer has favorited this copy-scoped card (v1.5.0). */
  isFavorite?: boolean;
  /** Toggle favorite/unfavorite for this copy-scoped card (v1.5.0). */
  onFavoriteToggle?: () => void;
}

interface BorrowControlProps {
  showBorrowButton: boolean;
  borrowRequestPending: boolean;
  onBorrowClick?: () => void;
}

/** Left-side borrow control in the action row. Renders nothing when not borrowable. */
function BorrowControl({
  showBorrowButton,
  borrowRequestPending,
  onBorrowClick,
}: BorrowControlProps) {
  if (!showBorrowButton) return null;
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!borrowRequestPending && onBorrowClick) onBorrowClick();
  };
  const className = borrowRequestPending
    ? "moo-button moo-borrow-btn moo-borrow-btn--pending"
    : "moo-button moo-borrow-btn";
  return (
    <button
      type="button"
      disabled={borrowRequestPending}
      onClick={handleClick}
      className={className}
    >
      {borrowRequestPending ? "申請中" : "申請借閱"}
    </button>
  );
}

export function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const className = active
    ? "moo-button moo-button--ghost-icon moo-button--pill moo-filter-btn moo-filter-btn--active"
    : "moo-button moo-button--ghost-icon moo-button--pill moo-filter-btn";
  return (
    <button onClick={onClick} className={className}>
      {label}
    </button>
  );
}

export function BookCard({
  book,
  showBorrowButton = false,
  onBorrowClick,
  borrowRequestPending = false,
  onHideToggle,
  hideActionLabel,
  isFavorite = false,
  onFavoriteToggle,
}: BookCardProps) {
  const menuItems: OverflowMenuItem[] = [];
  if (onHideToggle && hideActionLabel) {
    menuItems.push({ label: hideActionLabel, onSelect: onHideToggle });
  }
  const showMenu = menuItems.length > 0;
  const showFavorite = Boolean(onFavoriteToggle);

  return (
    <div className="moo-book-card">
      <a
        href={book.readmooUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="moo-book-card__link"
      >
        <div className="moo-book-card__cover-wrap">
          {/* width/height are only an intrinsic-ratio hint (CLS placeholder); actual
              responsive sizing lives in the .moo-book-card__cover class. */}
          <LazyCover
            src={safeCoverUrl(book.coverUrl)}
            alt={book.title}
            width={120}
            height={180}
            className="moo-book-card__cover"
            fallback={<div className="moo-book-card__cover-fallback" />}
          />
          {book.isUpdated === BoolFlag.TRUE && (
            <span
              aria-label="新分享書籍"
              className="moo-book-card__updated-badge"
            >
              更新
            </span>
          )}
        </div>
        <div className="moo-book-card__info">
          <span className="moo-book-card__title">{book.title}</span>
          {book.author && (
            <span className="moo-book-card__author">{book.author}</span>
          )}
          <span className="moo-book-card__member">{book.memberName}</span>
        </div>
      </a>
      <div className="moo-book-card__actions">
        <BorrowControl
          showBorrowButton={showBorrowButton}
          borrowRequestPending={borrowRequestPending}
          onBorrowClick={onBorrowClick}
        />
        <div className="moo-book-card__actions-end">
          {showFavorite && onFavoriteToggle && (
            <FavoriteButton
              isFavorite={isFavorite}
              onFavoriteToggle={onFavoriteToggle}
            />
          )}
          {showMenu && <OverflowMenu items={menuItems} tone="plain" />}
        </div>
      </div>
    </div>
  );
}
