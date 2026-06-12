import { CategoryFilter } from "@/components/CategoryFilter";
import { ViewModeToggle } from "@/components/ViewModeToggle";
import { BookSortDropdown } from "@/components/BookSortDropdown";
import type { BookSortMode } from "@/utils/sortBooks";
import type { MemberBooks } from "@/hooks/useFamilyData";
import type {
  BookWithMember,
  MemberFilterValue,
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
  showHidden: boolean;
  onShowHiddenToggle: () => void;
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
  showHidden,
  onShowHiddenToggle,
}: FamilyShelfToolbarProps) {
  const showHiddenClass = showHidden
    ? "text-blue-600 border-blue-600 bg-blue-50"
    : "text-gray-500 border-gray-300";
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
        <select
          value={filterMember}
          onChange={(e) => onMemberFilterChange(e.target.value as MemberFilterValue)}
          aria-label="篩選成員"
          className="moo-form-select flex-1 rounded-lg border border-gray-300 pl-3 pr-9 py-2.5 text-sm bg-white focus:border-blue-500 outline-none"
        >
          <option value="all">所有人的書</option>
          <option value="all-except-self">其他家人的書</option>
          <option value={userId}>自己的書</option>
          {members.filter((m) => m.userId !== userId).map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName || m.userId.slice(0, 8)}
            </option>
          ))}
        </select>
        <BookSortDropdown value={sort} onChange={onSortChange} />
      </div>

      <div className="mb-4">
        <button
          type="button"
          onClick={onShowHiddenToggle}
          aria-pressed={showHidden}
          className={`inline-flex items-center text-xs font-medium rounded-full px-3 py-1.5 border ${showHiddenClass}`}
        >
          顯示已隱藏
        </button>
      </div>
    </>
  );
}
