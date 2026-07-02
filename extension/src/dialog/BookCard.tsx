import React from "react";
import { BookEntry, BoolFlag } from "../api/client";
import { FavoriteButton } from "./FavoriteButton";
import { LazyCover } from "./LazyCover";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";

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
function BorrowControl({ showBorrowButton, borrowRequestPending, onBorrowClick }: BorrowControlProps) {
  if (!showBorrowButton) return null;
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!borrowRequestPending && onBorrowClick) onBorrowClick();
  };
  return (
    <button
      type="button"
      disabled={borrowRequestPending}
      onClick={handleClick}
      style={{
        padding: "6px 10px",
        border: "none",
        borderRadius: 6,
        background: borrowRequestPending ? "#e2e8f0" : "#2563eb",
        color: borrowRequestPending ? "#94a3b8" : "white",
        fontWeight: 600,
        fontSize: 12,
        cursor: borrowRequestPending ? "not-allowed" : "pointer",
      }}
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
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        border: active ? "1px solid #2563eb" : "1px solid #e2e8f0",
        borderRadius: 16,
        background: active ? "#eff6ff" : "transparent",
        color: active ? "#2563eb" : "#64748b",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
      }}
    >
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderRadius: 8,
        background: "#fff",
        border: "1px solid #f1f5f9",
        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
        overflow: "hidden",
      }}
    >
      <a
        href={book.readmooUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: "block", textDecoration: "none" }}
      >
        <div style={{ position: "relative" }}>
          {/* width/height are only an intrinsic-ratio hint (CLS placeholder); actual size is responsive via the style override below. */}
          <LazyCover
            src={book.coverUrl}
            alt={book.title}
            width={120}
            height={180}
            style={{ width: "100%", height: "auto", aspectRatio: "3 / 4", borderRadius: 0 }}
            fallback={<div style={{ width: "100%", aspectRatio: "3 / 4", background: "#f1f5f9" }} />}
          />
          {book.isUpdated === BoolFlag.TRUE && (
            <span
              aria-label="新分享書籍"
              style={{
                position: "absolute",
                bottom: 4,
                left: 4,
                background: "#dcfce7",
                color: "#16a34a",
                fontSize: 12,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 8,
                lineHeight: "16px",
              }}
            >
              更新
            </span>
          )}
        </div>
        <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#1e293b",
              textAlign: "left",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              lineHeight: "1.3",
            }}
          >
            {book.title}
          </span>
          {book.author && (
            <span style={{ fontSize: 12, color: "#94a3b8", textAlign: "left" }}>
              {book.author}
            </span>
          )}
          <span
            style={{
              alignSelf: "flex-start",
              display: "inline-block",
              fontSize: 12,
              color: "#2563eb",
              background: "#eff6ff",
              padding: "1px 6px",
              borderRadius: 8,
            }}
          >
            {book.memberName}
          </span>
        </div>
      </a>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px 8px", marginTop: "auto" }}>
        <BorrowControl
          showBorrowButton={showBorrowButton}
          borrowRequestPending={borrowRequestPending}
          onBorrowClick={onBorrowClick}
        />
        <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
          {showFavorite && onFavoriteToggle && (
            <FavoriteButton isFavorite={isFavorite} onFavoriteToggle={onFavoriteToggle} />
          )}
          {showMenu && <OverflowMenu items={menuItems} tone="plain" />}
        </div>
      </div>
    </div>
  );
}
