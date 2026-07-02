import React from "react";
import { BoolFlag } from "../api/client";
import type { BookWithMember } from "./BookCard";
import { FavoriteButton } from "./FavoriteButton";
import { LazyCover } from "./LazyCover";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";

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

  return (
    <a
      href={book.readmooUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 4px",
        borderBottom: "1px solid #e2e8f0",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        <LazyCover
          src={book.coverUrl}
          alt={book.title}
          width={40}
          height={60}
          style={{ borderRadius: 3 }}
          fallback={<div style={{ width: 40, height: 60, background: "#f1f5f9", borderRadius: 3 }} />}
        />
        {book.isUpdated === BoolFlag.TRUE && (
          <span
            aria-label="新分享書籍"
            style={{
              position: "absolute",
              bottom: -2,
              left: -2,
              background: "#dcfce7",
              color: "#16a34a",
              fontSize: 10,
              fontWeight: 600,
              padding: "0 4px",
              borderRadius: 6,
              lineHeight: "14px",
            }}
          >
            更新
          </span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#1e293b",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {book.title}
        </div>
        {book.author && (
          <div
            style={{
              fontSize: 12,
              color: "#94a3b8",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {book.author}
          </div>
        )}
      </div>
      <span
        style={{
          fontSize: 12,
          color: "#2563eb",
          background: "#eff6ff",
          padding: "1px 6px",
          borderRadius: 8,
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        {book.memberName}
      </span>
      {showBorrowButton && (
        <button
          type="button"
          disabled={borrowRequestPending}
          onClick={handleBorrow}
          style={{
            padding: "4px 10px",
            border: "none",
            borderRadius: 6,
            background: borrowRequestPending ? "#94a3b8" : "#2563eb",
            color: "white",
            fontWeight: 600,
            fontSize: 12,
            cursor: borrowRequestPending ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
        >
          {borrowRequestPending ? "申請中" : "申請借閱"}
        </button>
      )}
      {onFavoriteToggle && (
        <span style={{ flexShrink: 0, display: "inline-flex" }}>
          <FavoriteButton isFavorite={isFavorite} onFavoriteToggle={onFavoriteToggle} />
        </span>
      )}
      {menuItems.length > 0 && (
        <span style={{ flexShrink: 0 }}>
          <OverflowMenu items={menuItems} tone="plain" />
        </span>
      )}
    </a>
  );
}
