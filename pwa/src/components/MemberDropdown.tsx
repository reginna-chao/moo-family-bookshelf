import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { ReactNode } from "react";
import {
  Users,
  UsersRound,
  User,
  Heart,
  EyeOff,
  ChevronDown,
} from "lucide-react";
import {
  FAVORITE_FILTER_VALUE,
  HIDDEN_FILTER_VALUE,
  type MemberFilterValue,
} from "@/hooks/useFamilyShelfBooks";
import type { MemberBooks } from "@/hooks/useFamilyData";

export interface MemberDropdownProps {
  members: MemberBooks[];
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
  icon: ReactNode;
  /** TOTAL book count for this scope, INCLUDING hidden books. */
  count: number;
}

/**
 * Build the member-filter options. Ordering is fixed:
 * all / all-except-self / self / each other member with books / favorite / hidden.
 * Counts are totals (hidden books are NOT excluded).
 */
function buildOptions(
  members: MemberBooks[],
  userId: string,
  favoriteCount: number,
  hiddenCount: number,
): MemberOption[] {
  const allCount = members.reduce((sum, m) => sum + m.books.length, 0);
  const othersCount = members
    .filter((m) => m.userId !== userId)
    .reduce((sum, m) => sum + m.books.length, 0);
  const self = members.find((m) => m.userId === userId);
  const othersWithBooks = members.filter(
    (m) => m.userId !== userId && m.books.length > 0,
  );

  return [
    {
      key: "all",
      value: "all",
      label: "所有人的書",
      icon: <Users size={16} aria-hidden="true" />,
      count: allCount,
    },
    {
      key: "all-except-self",
      value: "all-except-self",
      label: "其他家人的書",
      icon: <UsersRound size={16} aria-hidden="true" />,
      count: othersCount,
    },
    {
      key: "self",
      value: userId,
      label: "自己的書",
      icon: <User size={16} aria-hidden="true" />,
      count: self ? self.books.length : 0,
    },
    ...othersWithBooks.map((m) => ({
      key: m.userId,
      value: m.userId,
      label: m.displayName || m.userId.slice(0, 8),
      icon: <User size={16} aria-hidden="true" />,
      count: m.books.length,
    })),
    {
      key: FAVORITE_FILTER_VALUE,
      value: FAVORITE_FILTER_VALUE,
      label: "我的最愛",
      icon: <Heart size={16} aria-hidden="true" />,
      count: favoriteCount,
    },
    {
      key: HIDDEN_FILTER_VALUE,
      value: HIDDEN_FILTER_VALUE,
      label: "隱藏的書",
      icon: <EyeOff size={16} aria-hidden="true" />,
      count: hiddenCount,
    },
  ];
}

/** Custom member-filter dropdown (PWA): icon + label trigger, popover listbox with counts. */
export function MemberDropdown({
  members,
  userId,
  value,
  onChange,
  favoriteCount,
  hiddenCount,
}: MemberDropdownProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const options = useMemo(
    () => buildOptions(members, userId, favoriteCount, hiddenCount),
    [members, userId, favoriteCount, hiddenCount],
  );
  const current = options.find((o) => o.value === value) ?? options[0];

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      // PWA is not in a Shadow DOM, so e.target is not retargeted — contains() is correct here (unlike the Extension dialog, which needs composedPath()).
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function handleSelect(next: MemberFilterValue) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div ref={popoverRef} className="relative flex-1">
      <button
        onClick={handleToggle}
        aria-label="篩選成員"
        aria-expanded={open}
        className="flex items-center justify-between w-full rounded-lg border border-gray-300 bg-white pl-3 pr-3 py-2.5 text-sm text-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
      >
        <span className="flex items-center gap-2 min-w-0">
          {current.icon}
          <span className="truncate">{current.label}</span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="text-gray-400 flex-shrink-0"
        />
      </button>
      {open && (
        <div
          className="absolute top-12 left-0 min-w-full max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50"
          role="listbox"
          aria-label="成員選單"
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            const rowClass = selected
              ? "bg-blue-50 text-blue-600"
              : "text-gray-700 hover:bg-gray-50";
            return (
              <button
                key={opt.key}
                role="option"
                aria-selected={selected}
                onClick={() => handleSelect(opt.value)}
                className={`flex items-center justify-between gap-2 w-full px-3 py-2 text-sm text-left ${rowClass}`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {opt.icon}
                  <span className="truncate">{opt.label}</span>
                </span>
                <span className="text-gray-400 text-xs flex-shrink-0">
                  {opt.count}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
