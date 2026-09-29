import { CategoryFilter } from "@/components/CategoryFilter";
import type { BookEntry } from "@/api/client";

export interface PersonalShelfSearchBarProps {
  searchTerm: string;
  onSearchTermChange: (term: string) => void;
  categoryBooks: BookEntry[];
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
}

export function PersonalShelfSearchBar({
  searchTerm,
  onSearchTermChange,
  categoryBooks,
  categoryFilter,
  onCategoryFilterChange,
}: PersonalShelfSearchBarProps) {
  return (
    <div className="flex gap-2 mb-3">
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => onSearchTermChange(e.target.value)}
        placeholder="搜尋書名或作者"
        aria-label="搜尋書名或作者"
        className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
      />
      <CategoryFilter
        books={categoryBooks}
        value={categoryFilter}
        onChange={onCategoryFilterChange}
      />
    </div>
  );
}
