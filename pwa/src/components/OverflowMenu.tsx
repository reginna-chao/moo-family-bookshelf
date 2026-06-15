import React, { useRef, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useAnchoredPosition } from "@/hooks/useAnchoredPosition";

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
 * The panel is portaled to `document.body` and positioned with `position: fixed`
 * from the trigger's bounding rect, so no ancestor `overflow: hidden` can clip
 * it. Closes on outside click, Escape, item select, scroll, or resize. All
 * listeners are attached only while open and removed on cleanup.
 */
export function OverflowMenu({ items, onOpenChange }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { position, place, reset } = useAnchoredPosition();

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (onOpenChange) onOpenChange(next);
  };

  const close = () => setOpenState(false);

  // Measure the panel after it mounts, then place it relative to the trigger.
  useLayoutEffect(() => {
    if (!open) {
      reset();
      return;
    }
    place(triggerRef.current, menuRef.current);
  }, [open, place, reset]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (isInsideMenu(e.target, triggerRef.current, menuRef.current)) return;
      close();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      close();
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label="更多選項"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleTriggerClick}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-500 hover:bg-gray-100"
      >
        <MoreHorizontal size={18} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="書籍選項"
            style={{
              position: "fixed",
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
            className="min-w-[120px] bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden"
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
          </div>,
          document.body,
        )}
    </div>
  );
}

function isInsideMenu(
  target: EventTarget | null,
  trigger: HTMLElement | null,
  menu: HTMLElement | null,
): boolean {
  if (!(target instanceof Node)) return false;
  if (trigger?.contains(target)) return true;
  if (menu?.contains(target)) return true;
  return false;
}
