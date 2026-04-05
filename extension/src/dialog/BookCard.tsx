import React from "react";
import { BookEntry } from "../api/client";

export interface BookWithMember extends BookEntry {
  memberName: string;
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

export function BookCard({ book }: { book: BookWithMember }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <a
        href={book.readmooUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: "block", textDecoration: "none" }}
      >
        <img
          src={book.coverUrl}
          alt={book.title}
          style={{ width: 80, height: 120, objectFit: "cover", borderRadius: 4, background: "#f1f5f9" }}
        />
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
      {book.category && (
        <span style={{ fontSize: 11, color: "#64748b", textAlign: "center" }} title={`分類：${book.category}`}>
          {book.category}
        </span>
      )}
      <span
        style={{
          fontSize: 11,
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
