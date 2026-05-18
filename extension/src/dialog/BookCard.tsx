import React, { useState } from "react";
import { BookEntry, BoolFlag } from "../api/client";

export interface BookWithMember extends BookEntry {
  memberName: string;
  isUpdated: BoolFlag;
}

export interface BookCardProps {
  book: BookWithMember;
  /** Show the "申請借閱" hover overlay (FamilyShelf context only). */
  showBorrowButton?: boolean;
  /** Triggered when user clicks the borrow button. */
  onBorrowClick?: () => void;
  /** Disables the borrow button (e.g. an existing PENDING request). */
  borrowRequestPending?: boolean;
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
}: BookCardProps) {
  const [hover, setHover] = useState(false);
  const overlayVisible = showBorrowButton && hover;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <a
        href={book.readmooUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: "block", textDecoration: "none", position: "relative" }}
      >
        <img
          src={book.coverUrl}
          alt={book.title}
          style={{ width: 120, height: 180, objectFit: "cover", borderRadius: 4, background: "#f1f5f9" }}
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
        {showBorrowButton && (
          <div
            aria-hidden={!overlayVisible}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(15, 23, 42, 0.55)",
              borderRadius: 4,
              opacity: overlayVisible ? 1 : 0,
              pointerEvents: overlayVisible ? "auto" : "none",
              transition: "opacity 0.15s",
            }}
          >
            <button
              type="button"
              disabled={borrowRequestPending}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!borrowRequestPending && onBorrowClick) onBorrowClick();
              }}
              style={{
                padding: "6px 10px",
                border: "none",
                borderRadius: 6,
                background: borrowRequestPending ? "#94a3b8" : "#2563eb",
                color: "white",
                fontWeight: 600,
                fontSize: 12,
                cursor: borrowRequestPending ? "not-allowed" : "pointer",
              }}
            >
              {borrowRequestPending ? "申請中" : "申請借閱"}
            </button>
          </div>
        )}
      </a>
      <a
        href={book.readmooUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "#1e293b",
          textDecoration: "none",
          textAlign: "center",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          lineHeight: "1.3",
          maxWidth: "100%",
        }}
      >
        {book.title}
      </a>
      {book.author && (
        <span style={{ fontSize: 12, color: "#94a3b8", textAlign: "center" }}>
          {book.author}
        </span>
      )}
      <span
        style={{
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
  );
}
