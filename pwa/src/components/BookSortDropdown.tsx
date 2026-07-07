import React from "react";
import type { BookSortMode } from "@/utils/sortBooks";

export interface BookSortDropdownProps {
  value: BookSortMode;
  onChange: (mode: BookSortMode) => void;
}

const OPTIONS: Array<{ value: BookSortMode; label: string }> = [
  { value: "default", label: "預設順序" },
  { value: "title-asc", label: "書名 A → Z" },
  { value: "title-desc", label: "書名 Z → A" },
  { value: "author-asc", label: "作者 A → Z" },
  { value: "author-desc", label: "作者 Z → A" },
];

export function BookSortDropdown({ value, onChange }: BookSortDropdownProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as BookSortMode)}
      aria-label="排序方式"
      className="moo-form-select rounded-lg border border-gray-300 pl-3 pr-9 py-2.5 text-sm bg-white focus:border-blue-500 outline-none"
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
