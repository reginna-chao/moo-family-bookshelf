import { useState, useRef, useMemo, useCallback } from "react";
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
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { countVisibleByMemberScope } from "moo-family-bookshelf-shared/familyShelf/memberScopeCounts";

export interface MemberDropdownProps {
  members: MemberBooks[];
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
  key: string;
  value: MemberFilterValue;
  label: string;
  icon: ReactNode;
  /** Books this option will show (before category / search); hidden excluded. */
  count: number;
}

/**
 * Build the member-filter options. Ordering is fixed:
 * all / all-except-self / self / each other member with books / favorite / hidden.
 * Member-scope counts exclude hidden books; favorite / hidden keep their totals.
 */
function buildOptions(
  members: MemberBooks[],
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
      key: "all",
      value: "all",
      label: "所有人的書",
      icon: <Users size={16} aria-hidden="true" />,
      count: counts.all,
    },
    {
      key: "all-except-self",
      value: "all-except-self",
      label: "其他家人的書",
      icon: <UsersRound size={16} aria-hidden="true" />,
      count: counts.allExceptSelf,
    },
    {
      key: "self",
      value: userId,
      label: "自己的書",
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(userId) ?? 0,
    },
    ...othersWithBooks.map((m) => ({
      key: m.userId,
      value: m.userId,
      label: m.displayName || m.userId.slice(0, 8),
      icon: <User size={16} aria-hidden="true" />,
      count: counts.byMember.get(m.userId) ?? 0,
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

/**
 * Custom member-filter dropdown (PWA): icon + label trigger, popover listbox
 * with counts. Closes on outside click or Escape via useDismissableMenu.
 */
export function MemberDropdown({
  members,
  userId,
  value,
  onChange,
  favoriteCount,
  hiddenCount,
  hiddenRefs,
}: MemberDropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const options = useMemo(
    () => buildOptions(members, userId, favoriteCount, hiddenCount, hiddenRefs),
    [members, userId, favoriteCount, hiddenCount, hiddenRefs],
  );
  const current = options.find((o) => o.value === value) ?? options[0];

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  useDismissableMenu({ isOpen: open, onClose: close, triggerRef, menuRef });

  function handleSelect(next: MemberFilterValue) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={triggerRef}
        onClick={handleToggle}
        aria-label="篩選成員"
        aria-expanded={open}
        className="flex items-center justify-between w-full rounded-lg border border-gray-300 bg-white pl-3 pr-3 py-2.5 text-sm text-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
      >
        <span className="flex items-center gap-2 min-w-0 [&>svg]:flex-shrink-0">
          {current.icon}
          <span className="truncate">{current.label}</span>
          {/* Label truncates on narrow widths; the count stays whole. */}
          <span aria-hidden="true" className="text-gray-400 flex-shrink-0">
            ·
          </span>
          <span className="text-gray-400 text-xs flex-shrink-0">
            {current.count}
          </span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="text-gray-400 flex-shrink-0"
        />
      </button>
      {open && (
        <div
          ref={menuRef}
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
