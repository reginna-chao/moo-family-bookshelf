import React, { useRef, useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

const UNCATEGORIZED = "未分類";

export interface CategoryFilterProps {
  books: { category: string }[];
  value: string;
  onChange: (value: string) => void;
  open: boolean;
  onToggle: () => void;
}

interface CategoryOption {
  label: string;
  value: string;
  count: number;
}

function buildCategories(books: { category: string }[]): CategoryOption[] {
  const map = new Map<string, number>();
  for (const b of books) {
    const key = b.category || UNCATEGORIZED;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, value: label, count }))
    .sort((a, b) => {
      if (a.label === UNCATEGORIZED) return 1;
      if (b.label === UNCATEGORIZED) return -1;
      return a.label.localeCompare(b.label, "zh-Hant");
    });
}

export function CategoryFilter({ books, value, onChange, open, onToggle }: CategoryFilterProps) {
  const categories = React.useMemo(() => buildCategories(books), [books]);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const triggerSize = isMobile ? 32 : 40;

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onToggle();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onToggle]);

  if (categories.length <= 1) return null;

  const isActive = value !== "";

  return (
    <div ref={popoverRef} style={{ position: "relative" }}>
      <button
        onClick={onToggle}
        aria-label="篩選分類"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: triggerSize,
          height: triggerSize,
          border: isActive ? "1px solid #2563eb" : "1px solid #e2e8f0",
          borderRadius: 8,
          background: isActive ? "#eff6ff" : "white",
          color: isActive ? "#2563eb" : "#94a3b8",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: triggerSize,
            right: 0,
            minWidth: 180,
            maxHeight: 240,
            overflowY: "auto",
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            zIndex: 50,
          }}
          role="listbox"
          aria-label="分類選單"
        >
          <button
            role="option"
            aria-selected={value === ""}
            onClick={() => { onChange(""); onToggle(); }}
            style={{
              display: "flex",
              justifyContent: "space-between",
              width: "100%",
              padding: "8px 12px",
              border: "none",
              background: value === "" ? "#eff6ff" : "transparent",
              color: value === "" ? "#2563eb" : "#334155",
              fontSize: 13,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span>全部分類</span>
            <span style={{ color: "#94a3b8", fontSize: 12 }}>{books.length}</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.value}
              role="option"
              aria-selected={value === cat.value}
              onClick={() => { onChange(cat.value); onToggle(); }}
              style={{
                display: "flex",
                justifyContent: "space-between",
                width: "100%",
                padding: "8px 12px",
                border: "none",
                background: value === cat.value ? "#eff6ff" : "transparent",
                color: value === cat.value ? "#2563eb" : "#334155",
                fontSize: 13,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span>{cat.label}</span>
              <span style={{ color: "#94a3b8", fontSize: 12 }}>{cat.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function filterByCategory<T extends { category: string }>(
  items: T[],
  category: string,
): T[] {
  if (!category) return items;
  if (category === UNCATEGORIZED) return items.filter((b) => !b.category);
  return items.filter((b) => b.category === category);
}
