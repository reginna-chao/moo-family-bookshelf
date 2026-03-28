import React from "react";
import { BookEntry } from "../api/client";

interface BookRowProps {
  book: BookEntry;
  selected: boolean;
  onSelect: (bookId: string) => void;
  onToggle: (bookId: string) => void;
}

export const BookRow = React.memo(function BookRow({ book, selected, onSelect, onToggle }: BookRowProps) {
  const isOn = book.isShared;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 8,
        borderRadius: 8,
        background: selected ? "#eff6ff" : "#f8fafc",
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onSelect(book.bookId)}
        aria-label={`選取 ${book.title}`}
        style={{ flexShrink: 0, width: 16, height: 16, cursor: "pointer" }}
      />
      {book.coverUrl ? (
        <img
          src={book.coverUrl}
          alt={book.title}
          style={{ width: 40, height: 60, objectFit: "cover", borderRadius: 4 }}
        />
      ) : (
        <div style={{ width: 40, height: 60, background: "#e2e8f0", borderRadius: 4 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{
            fontSize: 14,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}>
            {book.title}
          </span>
          {book.isArchived === 1 && (
            <span style={{
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 4,
              background: "#fef3c7",
              color: "#92400e",
              fontWeight: 500,
              flexShrink: 0,
            }}>
              封存
            </span>
          )}
        </div>
      </div>
      <button
        onClick={() => onToggle(book.bookId)}
        style={{
          flexShrink: 0,
          padding: "2px 8px",
          borderRadius: 10,
          border: "none",
          fontSize: 11,
          fontWeight: 600,
          background: isOn ? "#dcfce7" : "#f1f5f9",
          color: isOn ? "#16a34a" : "#94a3b8",
          cursor: "pointer",
        }}
      >
        {isOn ? "開放" : "未開放"}
      </button>
    </div>
  );
});
