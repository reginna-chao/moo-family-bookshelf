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
  const triggerClass = [
    "moo-category__trigger",
    isMobile ? "moo-category__trigger--mobile" : "",
    isActive ? "moo-category__trigger--active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const menuClass = isMobile
    ? "moo-category__menu moo-category__menu--mobile"
    : "moo-category__menu";
  const optionClass = (selected: boolean) =>
    selected ? "moo-category__option moo-category__option--selected" : "moo-category__option";

  return (
    <div ref={popoverRef} className="moo-category">
      <button
        onClick={onToggle}
        aria-label="篩選分類"
        aria-expanded={open}
        className={triggerClass}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && (
        <div className={menuClass} role="listbox" aria-label="分類選單">
          <button
            role="option"
            aria-selected={value === ""}
            onClick={() => { onChange(""); onToggle(); }}
            className={optionClass(value === "")}
          >
            <span>全部分類</span>
            <span className="moo-category__option-count">{books.length}</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.value}
              role="option"
              aria-selected={value === cat.value}
              onClick={() => { onChange(cat.value); onToggle(); }}
              className={optionClass(value === cat.value)}
            >
              <span>{cat.label}</span>
              <span className="moo-category__option-count">{cat.count}</span>
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
