import React from "react";
import { FilterButton } from "./BookCard";

export type StatusFilter = "all" | "shared" | "not-shared";

export interface StatusFilterBarProps {
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "shared", label: "已開放" },
  { value: "not-shared", label: "未開放" },
];

export function StatusFilterBar({ value, onChange }: StatusFilterBarProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginBottom: 12,
      }}
    >
      {STATUS_OPTIONS.map((opt) => (
        <FilterButton
          key={opt.value}
          label={opt.label}
          active={value === opt.value}
          onClick={() => onChange(opt.value)}
        />
      ))}
    </div>
  );
}
