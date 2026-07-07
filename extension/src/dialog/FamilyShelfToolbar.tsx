import { MemberDropdown, MemberFilterValue } from "./MemberDropdown";
import { SearchBar } from "./SearchBar";
import { CategoryFilter } from "./CategoryDropdown";
import { ViewModeToggle } from "./ViewModeToggle";
import { BookSortDropdown } from "./BookSortDropdown";
import type { BookSortMode } from "./sortBooks";
import type { MemberBooks } from "./FamilyDataContext";
import type { FamilyShelfBook } from "./useFamilyShelfBooks";

type ViewMode = "grid" | "row";

export interface FamilyShelfToolbarProps {
  headingCount: string;
  members: MemberBooks[];
  userId: string;
  filterMember: MemberFilterValue;
  onMemberFilterChange: (value: MemberFilterValue) => void;
  favoriteCount: number;
  hiddenCount: number;
  sort: BookSortMode;
  onSortChange: (sort: BookSortMode) => void;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  searchTotalCount: number;
  searchFilteredCount: number;
  isFiltering: boolean;
  categoryBooks: FamilyShelfBook[];
  categoryFilter: string;
  onCategoryChange: (value: string) => void;
  categoryOpen: boolean;
  onCategoryToggle: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

/** Family-shelf header + filter controls (Extension). */
export function FamilyShelfToolbar({
  headingCount,
  members,
  userId,
  filterMember,
  onMemberFilterChange,
  favoriteCount,
  hiddenCount,
  sort,
  onSortChange,
  searchTerm,
  onSearchChange,
  searchTotalCount,
  searchFilteredCount,
  isFiltering,
  categoryBooks,
  categoryFilter,
  onCategoryChange,
  categoryOpen,
  onCategoryToggle,
  viewMode,
  onViewModeChange,
}: FamilyShelfToolbarProps) {
  return (
    <>
      <h3 className="moo-toolbar__heading">
        家庭開放書櫃
        <span className="moo-toolbar__count">{headingCount}</span>
      </h3>

      <div className="moo-toolbar__row">
        <div className="moo-toolbar__grow">
          <MemberDropdown
            members={members}
            userId={userId}
            value={filterMember}
            onChange={onMemberFilterChange}
            favoriteCount={favoriteCount}
            hiddenCount={hiddenCount}
          />
        </div>
        <BookSortDropdown value={sort} onChange={onSortChange} />
      </div>
      <div className="moo-toolbar__row">
        <div className="moo-toolbar__grow">
          <SearchBar
            value={searchTerm}
            onChange={onSearchChange}
            totalCount={searchTotalCount}
            filteredCount={searchFilteredCount}
            isFiltering={isFiltering}
          />
        </div>
        <CategoryFilter
          books={categoryBooks}
          value={categoryFilter}
          onChange={onCategoryChange}
          open={categoryOpen}
          onToggle={onCategoryToggle}
        />
        <ViewModeToggle mode={viewMode} onChange={onViewModeChange} />
      </div>
    </>
  );
}
