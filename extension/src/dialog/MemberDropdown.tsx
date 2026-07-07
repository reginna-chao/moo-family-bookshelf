import React, { useState, useRef, useMemo } from "react";
import { Users, UsersRound, User, Heart, EyeOff, ChevronDown } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useDismissableMenu } from "../hooks/useDismissableMenu";

/** Sentinel filter value for the cross-everyone hidden-books view. */
export const HIDDEN_FILTER_VALUE = "__hidden__";

/** Sentinel filter value for the cross-everyone favorites view. */
export const FAVORITE_FILTER_VALUE = "__favorite__";

export type MemberFilterValue = "all-except-self" | "all" | string;

interface MemberInfo {
  userId: string;
  displayName: string;
  books: { bookId: string }[];
}

export interface MemberDropdownProps {
  members: MemberInfo[];
  userId: string;
  value: MemberFilterValue;
  onChange: (value: MemberFilterValue) => void;
  /** Total favorited shared cards across everyone (from useFamilyShelfBooks). */
  favoriteCount: number;
  /** Total hidden shared cards across everyone (from useFamilyShelfBooks). */
  hiddenCount: number;
}

interface MemberOption {
  key: string;
  value: MemberFilterValue;
  label: string;
  icon: React.ReactNode;
  /** TOTAL book count for this scope, INCLUDING hidden books. */
  count: number;
}

/**
 * Build the member-filter options. Ordering is fixed:
 * all / all-except-self / self / each other member with books / favorite / hidden.
 * Counts are totals (hidden books are NOT excluded).
 */
function buildOptions(
  members: MemberInfo[],
  userId: string,
  favoriteCount: number,
  hiddenCount: number,
): MemberOption[] {
  const allCount = members.reduce((sum, m) => sum + m.books.length, 0);
  const othersCount = members
    .filter((m) => m.userId !== userId)
    .reduce((sum, m) => sum + m.books.length, 0);
  const self = members.find((m) => m.userId === userId);
  const othersWithBooks = members.filter((m) => m.userId !== userId && m.books.length > 0);

  return [
    { key: "all", value: "all", label: "所有人的書", icon: <Users size={16} aria-hidden="true" />, count: allCount },
    {
      key: "all-except-self",
      value: "all-except-self",
      label: "其他家人的書",
      icon: <UsersRound size={16} aria-hidden="true" />,
      count: othersCount,
    },
    { key: "self", value: userId, label: "自己的書", icon: <User size={16} aria-hidden="true" />, count: self ? self.books.length : 0 },
    ...othersWithBooks.map((m) => ({
      key: m.userId,
      value: m.userId,
      label: m.displayName || m.userId.slice(0, 8),
      icon: <User size={16} aria-hidden="true" />,
      count: m.books.length,
    })),
    { key: FAVORITE_FILTER_VALUE, value: FAVORITE_FILTER_VALUE, label: "我的最愛", icon: <Heart size={16} aria-hidden="true" />, count: favoriteCount },
    { key: HIDDEN_FILTER_VALUE, value: HIDDEN_FILTER_VALUE, label: "隱藏的書", icon: <EyeOff size={16} aria-hidden="true" />, count: hiddenCount },
  ];
}

export function MemberDropdown({
  members,
  userId,
  value,
  onChange,
  favoriteCount,
  hiddenCount,
}: MemberDropdownProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const options = useMemo(
    () => buildOptions(members, userId, favoriteCount, hiddenCount),
    [members, userId, favoriteCount, hiddenCount],
  );
  const current = options.find((o) => o.value === value) ?? options[0];

  useDismissableMenu({ isOpen: open, onClose: () => setOpen(false), triggerRef, menuRef });

  function handleSelect(next: MemberFilterValue) {
    onChange(next);
    setOpen(false);
  }

  const triggerClass = isMobile
    ? "moo-member-filter__trigger moo-member-filter__trigger--mobile"
    : "moo-member-filter__trigger";
  const menuClass = isMobile
    ? "moo-member-filter__menu moo-member-filter__menu--mobile"
    : "moo-member-filter__menu";
  const optionClass = (selected: boolean) =>
    selected ? "moo-category__option moo-category__option--selected" : "moo-category__option";

  return (
    <div className="moo-member-filter">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="篩選成員"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClass}
      >
        <span className="moo-member-filter__current">
          {current.icon}
          <span className="moo-member-filter__current-label">{current.label}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" className="moo-member-filter__chevron" />
      </button>
      {open && (
        <div ref={menuRef} className={menuClass} role="listbox" aria-label="成員選單">
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              onClick={() => handleSelect(opt.value)}
              className={optionClass(opt.value === value)}
            >
              <span className="moo-member-filter__option-label">
                {opt.icon}
                {opt.label}
              </span>
              <span className="moo-category__option-count">{opt.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
