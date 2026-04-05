import React from "react";

const UNCATEGORIZED = "未分類";

export interface CategoryDropdownProps {
  books: { category: string }[];
  value: string;
  onChange: (value: string) => void;
}

export function CategoryDropdown({ books, value, onChange }: CategoryDropdownProps) {
  const categories = React.useMemo(() => {
    const set = new Set<string>();
    for (const b of books) {
      set.add(b.category || UNCATEGORIZED);
    }
    return Array.from(set).sort((a, b) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b, "zh-Hant");
    });
  }, [books]);

  if (categories.length <= 1) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="篩選分類"
        style={{
          width: "100%",
          padding: "8px 12px",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          fontSize: 14,
          background: "white",
          color: "#334155",
          cursor: "pointer",
          outline: "none",
        }}
      >
        <option value="">全部分類</option>
        {categories.map((cat) => (
          <option key={cat} value={cat}>
            {cat}
          </option>
        ))}
      </select>
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
