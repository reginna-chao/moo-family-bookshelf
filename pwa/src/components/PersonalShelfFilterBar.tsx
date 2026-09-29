import { BookSortDropdown } from "@/components/BookSortDropdown";
import type { BookSortMode } from "moo-family-bookshelf-shared/familyShelf/sortBooks";
import type { StatusFilter } from "@/hooks/usePersonalShelfView";

export interface PersonalShelfFilterBarProps {
  statusFilter: StatusFilter;
  onStatusFilterChange: (filter: StatusFilter) => void;
  sort: BookSortMode;
  onSortChange: (mode: BookSortMode) => void;
}

/** Share-status filter pills + sort dropdown (PWA personal shelf). */
export function PersonalShelfFilterBar({
  statusFilter,
  onStatusFilterChange,
  sort,
  onSortChange,
}: PersonalShelfFilterBarProps) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="flex gap-2 flex-1">
        {(["all", "shared", "not-shared"] as const).map((f) => (
          <button
            key={f}
            onClick={() => {
              onStatusFilterChange(f);
            }}
            aria-pressed={statusFilter === f}
            className={`px-3 py-1.5 text-xs rounded-full ${
              statusFilter === f
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            {f === "all" ? "全部" : f === "shared" ? "已開放" : "未開放"}
          </button>
        ))}
      </div>
      <BookSortDropdown value={sort} onChange={onSortChange} />
    </div>
  );
}
