import { MemberDropdown, MemberFilterValue } from "./MemberDropdown";
import { SearchBar } from "./SearchBar";
import { CategoryFilter } from "./CategoryDropdown";
import { ViewModeToggle } from "./ViewModeToggle";
import { BookSortDropdown } from "./BookSortDropdown";
import type { BookSortMode } from "./sortBooks";
import type { MemberBooks } from "./FamilyDataContext";
import type { FamilyShelfBook } from "./useFamilyShelfBooks";

type ViewMode = "grid" | "row";

const rowStyle = { display: "flex", gap: 8, marginBottom: 12 } as const;

export interface FamilyShelfToolbarProps {
  headingCount: string;
  members: MemberBooks[];
  userId: string;
  filterMember: MemberFilterValue;
  onMemberFilterChange: (value: MemberFilterValue) => void;
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
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
        家庭開放書櫃
        <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: 8, fontSize: 13 }}>
          {headingCount}
        </span>
      </h3>

      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <MemberDropdown
            members={members}
            userId={userId}
            value={filterMember}
            onChange={onMemberFilterChange}
          />
        </div>
        <BookSortDropdown value={sort} onChange={onSortChange} />
      </div>
      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
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
