import { CategoryFilter } from "@/components/CategoryFilter";
import { ViewModeToggle } from "@/components/ViewModeToggle";
import { BookSortDropdown } from "@/components/BookSortDropdown";
import { MemberDropdown } from "@/components/MemberDropdown";
import type { BookSortMode } from "@/utils/sortBooks";
import type { MemberBooks } from "@/hooks/useFamilyData";
import {
  type BookWithMember,
  type MemberFilterValue,
} from "@/hooks/useFamilyShelfBooks";

type ViewMode = "grid" | "row";

export interface FamilyShelfToolbarProps {
  headingCount: string;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  categoryBooks: BookWithMember[];
  categoryFilter: string;
  onCategoryChange: (value: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  filterMember: MemberFilterValue;
  onMemberFilterChange: (value: MemberFilterValue) => void;
  members: MemberBooks[];
  userId: string;
  sort: BookSortMode;
  onSortChange: (sort: BookSortMode) => void;
  favoriteCount: number;
  hiddenCount: number;
}

/** Family-shelf header + filter controls (PWA). */
export function FamilyShelfToolbar({
  headingCount,
  searchTerm,
  onSearchChange,
  categoryBooks,
  categoryFilter,
  onCategoryChange,
  viewMode,
  onViewModeChange,
  filterMember,
  onMemberFilterChange,
  members,
  userId,
  sort,
  onSortChange,
  favoriteCount,
  hiddenCount,
}: FamilyShelfToolbarProps) {
  return (
    <>
      <h2 className="text-xl font-bold text-gray-900 mb-3">
        家庭開放書櫃
        <span className="text-gray-400 text-sm font-normal ml-2">
          {headingCount}
        </span>
      </h2>

      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜尋書名或作者"
          aria-label="搜尋書名或作者"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
        />
        <CategoryFilter
          books={categoryBooks}
          value={categoryFilter}
          onChange={onCategoryChange}
        />
        <ViewModeToggle mode={viewMode} onChange={onViewModeChange} />
      </div>

      <div className="flex gap-2 mb-4">
        <MemberDropdown
          members={members}
          userId={userId}
          value={filterMember}
          onChange={onMemberFilterChange}
          favoriteCount={favoriteCount}
          hiddenCount={hiddenCount}
        />
        <BookSortDropdown value={sort} onChange={onSortChange} />
      </div>
    </>
  );
}
