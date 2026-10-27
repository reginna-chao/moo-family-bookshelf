import React, { useRef, useLayoutEffect, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useAnchoredPosition } from "@/hooks/useAnchoredPosition";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";

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
 * it. Closes on outside click, Escape, item select, page scroll, or resize
 * (dismissal via useDismissableMenu, whose listeners exist only while open).
 * Opening focuses the first item; Arrow keys / Tab move through the items.
 */
export function OverflowMenu({ items, onOpenChange }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { position, place, reset } = useAnchoredPosition();
  // Guards the "focus first item once positioned" effect so repositioning does
  // not yank focus back to the first item mid-navigation.
  const didFocusRef = useRef(false);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (onOpenChange) onOpenChange(next);
  };

  const isFocusInsideMenu = (): boolean => {
    const active = document.activeElement;
    return !!active && !!menuRef.current?.contains(active);
  };

  // preventScroll: the menu closes on scroll, and re-focusing the trigger
  // would otherwise scroll it back into view and undo the user's scroll.
  const restoreTriggerFocus = () =>
    triggerRef.current?.focus({ preventScroll: true });

  /** Shared close path (outside click, Escape, scroll, resize). Focus returns to the trigger ONLY
   *  if still inside the panel, or the element the user just clicked would lose it. */
  const close = () => {
    const focusWasInside = isFocusInsideMenu();
    setOpenState(false);
    if (focusWasInside) restoreTriggerFocus();
  };

  // Measure the panel after it mounts, then place it relative to the trigger.
  useLayoutEffect(() => {
    if (!open) {
      reset();
      return;
    }
    place(triggerRef.current, menuRef.current);
  }, [open, place, reset]);

  const menuItems = (): HTMLButtonElement[] =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );

  // The portaled panel sits at the DOM's end where Tab never lands: focus its first item once
  // positioned (visible); the keyboard nav below keeps focus inside until close.
  useEffect(() => {
    if (!open) {
      didFocusRef.current = false;
      return;
    }
    if (didFocusRef.current || !position) return;
    const first =
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    if (first) {
      first.focus({ preventScroll: true });
      didFocusRef.current = true;
    }
  }, [open, position]);

  // The fixed-position panel detaches from its trigger when the page moves, so
  // this menu (unlike the inline dropdowns) also closes on scroll and resize.
  useDismissableMenu({
    isOpen: open,
    onClose: close,
    triggerRef,
    menuRef,
    dismissOnScroll: true,
  });

  const moveFocus = (dir: 1 | -1) => {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.findIndex((el) => el === document.activeElement);
    const nextIndex = (current + dir + items.length) % items.length;
    items[nextIndex]?.focus({ preventScroll: true });
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Escape belongs to the menu, not an enclosing modal (two layers would close). close()
      // restores trigger focus, since focus is still inside the panel here.
      e.stopPropagation();
      close();
    }
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenState(!open);
  };

  const handleItemClick = (e: React.MouseEvent, item: OverflowMenuItem) => {
    e.preventDefault();
    e.stopPropagation();
    // detail === 0 is a keyboard click: restore trigger focus BEFORE onSelect, since a destructive
    // option (e.g. 隱藏書籍) can unmount the trigger and strand focus on <body>.
    if (e.detail === 0) restoreTriggerFocus();
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
            onKeyDown={handleMenuKeyDown}
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
                className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none whitespace-nowrap"
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
