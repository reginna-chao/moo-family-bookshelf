import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { SlidersHorizontal } from "lucide-react";

const UNCATEGORIZED = "未分類";

interface CategoryOption {
  label: string;
  value: string;
  count: number;
}

interface CategoryFilterProps {
  books: { category: string }[];
  value: string;
  onChange: (value: string) => void;
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

export function CategoryFilter({ books, value, onChange }: CategoryFilterProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const categories = useMemo(() => buildCategories(books), [books]);

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Reset open state when value is cleared externally
  useEffect(() => {
    if (value === "") setOpen(false);
  }, [value]);

  if (categories.length <= 1) return null;

  const isActive = value !== "";

  return (
    <div ref={popoverRef} className="relative flex-shrink-0">
      <button
        onClick={handleToggle}
        aria-label="篩選分類"
        aria-expanded={open}
        className={`flex items-center justify-center w-10 h-10 rounded-lg border transition-colors ${
          isActive
            ? "border-blue-500 bg-blue-50 text-blue-600"
            : "border-gray-300 bg-white text-gray-400"
        }`}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && (
        <div
          className="absolute top-12 right-0 min-w-[180px] max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50"
          role="listbox"
          aria-label="分類選單"
        >
          <button
            role="option"
            aria-selected={value === ""}
            onClick={() => { onChange(""); setOpen(false); }}
            className={`flex justify-between w-full px-3 py-2 text-sm text-left ${
              value === "" ? "bg-blue-50 text-blue-600" : "text-gray-700 hover:bg-gray-50"
            }`}
          >
            <span>全部分類</span>
            <span className="text-gray-400 text-xs">{books.length}</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.value}
              role="option"
              aria-selected={value === cat.value}
              onClick={() => { onChange(cat.value); setOpen(false); }}
              className={`flex justify-between w-full px-3 py-2 text-sm text-left ${
                value === cat.value ? "bg-blue-50 text-blue-600" : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              <span>{cat.label}</span>
              <span className="text-gray-400 text-xs">{cat.count}</span>
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
