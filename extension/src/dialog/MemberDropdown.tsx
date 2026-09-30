import React, { useState, useRef, useMemo } from "react";
import {
  Users,
  UsersRound,
  User,
  Heart,
  EyeOff,
  ChevronDown,
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
import type { FamilyShelfMemberBooks } from "moo-family-bookshelf-shared/familyShelf/prefRefs";
import { countVisibleByMemberScope } from "moo-family-bookshelf-shared/familyShelf/memberScopeCounts";
import { memberFilterAccessibleName } from "moo-family-bookshelf-shared/familyShelf/memberFilterLabel";

/** Sentinel filter value for the cross-everyone hidden-books view. */
export const HIDDEN_FILTER_VALUE = "__hidden__";

/** Sentinel filter value for the cross-everyone favorites view. */
export const FAVORITE_FILTER_VALUE = "__favorite__";

export type MemberFilterValue = "all-except-self" | "all" | string;

type MemberInfo = FamilyShelfMemberBooks & { displayName: string };

export interface MemberDropdownProps {
  members: MemberInfo[];
  userId: string;
  value: MemberFilterValue;
  onChange: (value: MemberFilterValue) => void;
  /** Total favorited shared cards across everyone (from useFamilyShelfBooks). */
  favoriteCount: number;
  /** Total hidden shared cards across everyone (from useFamilyShelfBooks). */
  hiddenCount: number;
  /** Viewer's hidden refs; member-scope counts leave these books out. */
  hiddenRefs: ReadonlySet<string>;
}

interface MemberOption {
  value: MemberFilterValue;
  label: string;
  icon: React.ReactNode;
  /** Books this option will show (before category / search); hidden excluded. */
  count: number;
}

/**
 * Options in fixed order (each `value` is unique: the React key): all / all-except-
 * self / self / others with books / favorite / hidden. Member-scope counts exclude
 * hidden books; favorite / hidden keep their totals. */
function buildOptions(
  members: MemberInfo[],
  userId: string,
  favoriteCount: number,
  hiddenCount: number,
  hiddenRefs: ReadonlySet<string>,
): MemberOption[] {
  const counts = countVisibleByMemberScope(members, userId, hiddenRefs);
  const othersWithBooks = members.filter(
    (m) => m.userId !== userId && m.books.length > 0,
  );

  return [
    {
      value: "all",
      label: "所有人的書",
      icon: <Users size={16} aria-hidden="true" />,
      count: counts.all,
    },
    {
      value: "all-except-self",
      label: "其他家人的書",
      icon: <UsersRound size={16} aria-hidden="true" />,
      count: counts.allExceptSelf,
    },
    {
      value: userId,
      label: "自己的書",
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(userId) ?? 0,
    },
    ...othersWithBooks.map((m) => ({
      value: m.userId,
      label: m.displayName || m.userId.slice(0, 8),
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(m.userId) ?? 0,
    })),
    {
      value: FAVORITE_FILTER_VALUE,
      label: "我的最愛",
      icon: <Heart size={16} aria-hidden="true" />,
      count: favoriteCount,
    },
    {
      value: HIDDEN_FILTER_VALUE,
      label: "隱藏的書",
      icon: <EyeOff size={16} aria-hidden="true" />,
      count: hiddenCount,
    },
  ];
}

export function MemberDropdown({
  members,
  userId,
  value,
  onChange,
  favoriteCount,
  hiddenCount,
  hiddenRefs,
}: MemberDropdownProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const options = useMemo(
    () => buildOptions(members, userId, favoriteCount, hiddenCount, hiddenRefs),
    [members, userId, favoriteCount, hiddenCount, hiddenRefs],
  );
  const current = options.find((o) => o.value === value) ?? options[0];

  useDismissableMenu({
    isOpen: open,
    onClose: () => setOpen(false),
    triggerRef,
    menuRef,
  });

  function handleSelect(next: MemberFilterValue) {
    onChange(next);
    setOpen(false);
  }

  const triggerClass = isMobile
    ? "moo-form-input moo-member-filter__trigger moo-member-filter__trigger--mobile"
    : "moo-form-input moo-member-filter__trigger";
  const menuClass = isMobile
    ? "moo-member-filter__menu moo-member-filter__menu--mobile"
    : "moo-member-filter__menu";
  const optionClass = (selected: boolean) =>
    selected
      ? "moo-category__option moo-category__option--selected"
      : "moo-category__option";

  return (
    <div className="moo-member-filter">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={memberFilterAccessibleName(current.label, current.count)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClass}
      >
        <span className="moo-member-filter__current">
          {current.icon}
          <span className="moo-member-filter__current-label">
            {current.label}
          </span>
          <span className="moo-member-filter__sep" aria-hidden="true">
            ·
          </span>
          <span className="moo-member-filter__count">{current.count}</span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="moo-member-filter__chevron"
        />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={menuClass}
          role="listbox"
          aria-label="成員選單"
        >
          {options.map((opt) => (
            <button
              key={opt.value}
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
