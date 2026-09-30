import { useState, useRef, useMemo, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import type { MemberFilterValue } from "@/hooks/useFamilyShelfBooks";
import type { MemberBooks } from "@/hooks/useFamilyData";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { buildOptions } from "@/components/memberFilterOptions";
import { memberFilterAccessibleName } from "moo-family-bookshelf-shared/familyShelf/memberFilterLabel";

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

/**
 * Custom member-filter dropdown (PWA): icon + label trigger, popover listbox
 * with counts. Closes on outside click or Escape via useDismissableMenu.
 * Choosing an option or pressing Escape returns focus to the trigger, whose
 * accessible name then announces the new scope and count.
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

  useDismissableMenu({
    isOpen: open,
    onClose: close,
    triggerRef,
    menuRef,
    returnFocusOnEscape: true,
  });

  function handleSelect(next: MemberFilterValue) {
    onChange(next);
    setOpen(false);
    // The option unmounts with the menu; land focus back on the trigger.
    triggerRef.current?.focus();
  }

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={triggerRef}
        onClick={handleToggle}
        aria-label={memberFilterAccessibleName(current.label, current.count)}
        aria-expanded={open}
        className="flex items-center justify-between w-full rounded-lg border border-gray-300 bg-white pl-3 pr-3 py-2.5 text-sm text-gray-700 focus-visible:border-blue-500 focus-visible:ring-1 focus-visible:ring-blue-500 outline-none"
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
