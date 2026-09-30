import { useState, useRef, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
import { memberFilterAccessibleName } from "moo-family-bookshelf-shared/familyShelf/memberFilterLabel";
import {
  buildOptions,
  type MemberFilterValue,
  type MemberInfo,
} from "./memberFilterOptions";

// The option model moved to ./memberFilterOptions; re-exported so existing
// importers of "./MemberDropdown" / "@/dialog/MemberDropdown" keep working.
export {
  HIDDEN_FILTER_VALUE,
  FAVORITE_FILTER_VALUE,
  type MemberFilterValue,
} from "./memberFilterOptions";

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

/**
 * Custom member-filter dropdown (Extension): icon + label trigger, popover
 * listbox with counts. Choosing an option or pressing Escape returns focus to
 * the trigger, whose accessible name then announces the new scope and count.
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
    returnFocusOnEscape: true,
  });

  function handleSelect(next: MemberFilterValue) {
    onChange(next);
    setOpen(false);
    // The option unmounts with the menu; land focus back on the trigger.
    triggerRef.current?.focus();
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
