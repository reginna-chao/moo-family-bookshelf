import React from "react";

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  totalCount: number;
  filteredCount: number;
  isFiltering: boolean;
}

export function SearchBar({
  value,
  onChange,
  totalCount,
  filteredCount,
  isFiltering,
}: SearchBarProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ position: "relative" }}>
        <span
          style={{
            position: "absolute",
            left: 10,
            top: "50%",
            transform: "translateY(-50%)",
            color: "#94a3b8",
            fontSize: 14,
            pointerEvents: "none",
          }}
          aria-hidden="true"
        >
          🔍
        </span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="搜尋書名或作者..."
          aria-label="搜尋書名或作者"
          style={{
            width: "100%",
            padding: "8px 12px 8px 32px",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            fontSize: 14,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>
      {isFiltering && (
        <p
          style={{
            fontSize: 12,
            color: "#64748b",
            marginTop: 4,
            marginBottom: 0,
          }}
          data-testid="search-count"
        >
          顯示 {filteredCount} / {totalCount} 本
        </p>
      )}
    </div>
  );
}
