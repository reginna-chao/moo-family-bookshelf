import React from "react";
import { Search } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  totalCount: number;
  filteredCount: number;
  isFiltering: boolean;
}

export function SearchBar({
  value,
  onChange,
  totalCount,
  filteredCount,
  isFiltering,
}: SearchBarProps) {
  const isMobile = useIsMobile();
  // Mobile uses a 32px-tall touch target (user-specified, below the 44px guideline).
  const inputClass = isMobile ? "moo-search__input moo-search__input--mobile" : "moo-search__input";
  return (
    <div className="moo-search">
      <div className="moo-search__field">
        <span className="moo-search__icon" aria-hidden="true">
          <Search size={14} />
        </span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="搜尋書名或作者..."
          aria-label="搜尋書名或作者"
          className={inputClass}
        />
      </div>
      {isFiltering && (
        <p className="moo-search__count" data-testid="search-count">
          顯示 {filteredCount} / {totalCount} 本
        </p>
      )}
    </div>
  );
}
