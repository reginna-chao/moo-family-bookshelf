import React from "react";
import type { BookSortMode } from "./sortBooks";

export interface BookSortDropdownProps {
  value: BookSortMode;
  onChange: (mode: BookSortMode) => void;
}

const OPTIONS: Array<{ value: BookSortMode; label: string }> = [
  { value: "default", label: "預設順序" },
  { value: "title", label: "依書名排序" },
  { value: "author", label: "依作者排序" },
];

export function BookSortDropdown({ value, onChange }: BookSortDropdownProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as BookSortMode)}
      aria-label="書籍排序"
      style={{
        padding: "8px 12px",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: "white",
        fontSize: 13,
        color: "#334155",
        cursor: "pointer",
      }}
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
