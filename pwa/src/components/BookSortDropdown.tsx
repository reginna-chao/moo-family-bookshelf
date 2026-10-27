import React, { useState, useRef, useId, useLayoutEffect } from "react";
import { ArrowDownWideNarrow } from "lucide-react";
import type { BookSortMode } from "moo-family-bookshelf-shared/familyShelf/sortBooks";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";

export interface BookSortDropdownProps {
  value: BookSortMode;
  onChange: (mode: BookSortMode) => void;
}

const OPTIONS: Array<{ value: BookSortMode; label: string }> = [
  { value: "default", label: "預設順序" },
  { value: "title-asc", label: "書名 A → Z" },
  { value: "title-desc", label: "書名 Z → A" },
  { value: "author-asc", label: "作者 A → Z" },
  { value: "author-desc", label: "作者 Z → A" },
];

// Clamp an index to the option list bounds (↑/↓ stop at edges, no wrap-around).
function clampIndex(index: number): number {
  if (index < 0) return 0;
  if (index > OPTIONS.length - 1) return OPTIONS.length - 1;
  return index;
}

// Selected (blue) wins; a keyboard-active unselected option gets neutral grey; the rest are
// transparent. Mirrors the Extension's optionClass.
function optionClass(selected: boolean, active: boolean): string {
  if (selected) return "bg-blue-50 text-blue-600";
  if (active) return "bg-gray-100 text-gray-700";
  return "text-gray-700 hover:bg-gray-50";
}

/**
 * Sort dropdown (PWA): icon-button trigger + popover listbox, mirroring the
 * Extension BookSortDropdown behavior with Tailwind styling. Opening focuses
 * the listbox; Arrow keys / Home / End move the active option and Enter /
 * Space choose it. Closes on outside click or Escape via useDismissableMenu.
 * Choosing an option or pressing Escape returns focus to the trigger.
 */
export function BookSortDropdown({ value, onChange }: BookSortDropdownProps) {
  const [open, setOpen] = useState(false);
  // Which option the keyboard cursor points at (aria-activedescendant target).
  const [activeValue, setActiveValue] = useState<BookSortMode>(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isActive = value !== "default";
  const optionId = useId();

  const optionIdFor = (mode: BookSortMode) => `${optionId}-${mode}`;

  const handleToggle = () => {
    if (!open) setActiveValue(value);
    setOpen(!open);
  };
  const close = () => setOpen(false);

  // The listbox is inline (absolute, not portaled), so it can take focus as soon as it mounts.
  useLayoutEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  useDismissableMenu({ isOpen: open, onClose: close, triggerRef, menuRef });

  function handleSelect(mode: BookSortMode) {
    onChange(mode);
    setOpen(false);
    // The option unmounts with the menu; land focus back on the trigger.
    triggerRef.current?.focus();
  }

  const moveActiveTo = (index: number) => {
    setActiveValue(OPTIONS[clampIndex(index)].value);
  };

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = OPTIONS.findIndex((opt) => opt.value === activeValue);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveTo(currentIndex + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveTo(currentIndex - 1);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      moveActiveTo(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      moveActiveTo(OPTIONS.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelect(activeValue);
    }
  };

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        aria-label="排序方式"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex items-center justify-center w-10 h-10 rounded-lg border transition-colors ${
          isActive
            ? "border-blue-500 bg-blue-50 text-blue-600"
            : "border-gray-300 bg-white text-gray-400"
        }`}
      >
        <ArrowDownWideNarrow size={16} />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="absolute top-12 right-0 min-w-[160px] max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50 outline-none"
          role="listbox"
          aria-label="排序方式選單"
          tabIndex={-1}
          aria-activedescendant={optionIdFor(activeValue)}
          onKeyDown={handleListKeyDown}
        >
          {OPTIONS.map((opt) => {
            const selected = opt.value === value;
            const active = opt.value === activeValue;
            return (
              <button
                key={opt.value}
                id={optionIdFor(opt.value)}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => handleSelect(opt.value)}
                className={`w-full px-3 py-2 text-sm text-left ${optionClass(selected, active)}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
