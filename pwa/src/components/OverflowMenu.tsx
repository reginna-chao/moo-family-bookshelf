import React, { useRef, useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  /** Notifies the parent when the menu opens/closes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Reusable "⋯" (horizontal meatballs) overflow menu (PWA).
 *
 * Anchored, absolutely-positioned menu. Closes on outside click, Escape, or
 * item select. All listeners are attached only while open and removed on
 * cleanup. Designed to host multiple items; currently used with one.
 */
export function OverflowMenu({ items, onOpenChange }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (onOpenChange) onOpenChange(next);
  };

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        if (onOpenChange) onOpenChange(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      if (onOpenChange) onOpenChange(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onOpenChange]);

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenState(!open);
  };

  const handleItemClick = (e: React.MouseEvent, item: OverflowMenuItem) => {
    e.preventDefault();
    e.stopPropagation();
    item.onSelect();
    setOpenState(false);
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="更多選項"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleTriggerClick}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-500 hover:bg-gray-100"
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="書籍選項"
          className="absolute top-8 right-0 min-w-[120px] bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={(e) => handleItemClick(e, item)}
              className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 whitespace-nowrap"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
