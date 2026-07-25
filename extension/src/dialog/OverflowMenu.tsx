import React, { useRef, useLayoutEffect, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePortalContainer } from "./PortalContainerContext";

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  /** Notifies the parent when the menu opens/closes (e.g. to keep the trigger visible). */
  onOpenChange?: (open: boolean) => void;
  /** "overlay" = white-on-dark (over a cover); "plain" = grey-on-transparent (in a row). */
  tone?: "overlay" | "plain";
}

/**
 * Reusable "⋯" (horizontal meatballs) overflow menu (Extension).
 *
 * The panel is portaled into the dialog's portal container (the Shadow Root in
 * production, `document.body` on the dev page) and positioned with
 * `position: fixed` from the trigger's bounding rect, so the Dialog's
 * `overflow: hidden` cannot clip it. Closes on outside click, Escape, item
 * select, scroll, or resize. All listeners are attached only while open and
 * removed on cleanup.
 */
export function OverflowMenu({
  items,
  onOpenChange,
  tone = "overlay",
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const portalContainer = usePortalContainer();
  const { position, place, reset } = useAnchoredPosition();

  const triggerClass = [
    "moo-button moo-button--ghost-icon moo-overflow__trigger",
    isMobile ? "moo-overflow__trigger--mobile" : "",
    tone === "plain"
      ? "moo-overflow__trigger--plain"
      : "moo-overflow__trigger--overlay",
  ]
    .filter(Boolean)
    .join(" ");

  // Guards the "focus first item once positioned" effect so repositioning does
  // not yank focus back to the first item mid-navigation.
  const didFocusRef = useRef(false);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (onOpenChange) onOpenChange(next);
  };

  // Read activeElement off getRootNode(): inside a shadow tree
  // document.activeElement is retargeted to the host.
  const activeElementInRoot = (): Element | null => {
    const root = menuRef.current?.getRootNode() as Document | ShadowRoot | null;
    return root?.activeElement ?? null;
  };

  const isFocusInsideMenu = (): boolean => {
    const active = activeElementInRoot();
    return !!active && !!menuRef.current?.contains(active);
  };

  // preventScroll: the menu can close on scroll, and re-focusing the trigger
  // would otherwise scroll it back into view and undo the user's scroll.
  const restoreTriggerFocus = () =>
    triggerRef.current?.focus({ preventScroll: true });

  /**
   * Shared close path (outside click, Escape, scroll, resize). Focus is handed
   * back to the trigger ONLY when it is still inside the panel — otherwise the
   * element the user just clicked would be robbed of focus.
   */
  const close = () => {
    const focusWasInside = isFocusInsideMenu();
    setOpenState(false);
    if (focusWasInside) restoreTriggerFocus();
  };

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

  // The panel is portaled to the end of the DOM, so keyboard Tab never lands on
  // it. Move focus to the first item once the menu is positioned (visible), then
  // keyboard nav below keeps focus inside until close.
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

  useDismissableMenu({ isOpen: open, onClose: close, triggerRef, menuRef });

  const moveFocus = (dir: 1 | -1) => {
    const items = menuItems();
    if (items.length === 0) return;
    const active = activeElementInRoot();
    const current = items.findIndex((el) => el === active);
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
      // Escape belongs to the menu: stop it from reaching an enclosing modal
      // (which would otherwise close two layers at once). close() restores the
      // trigger focus because focus is still inside the panel here.
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
    // detail === 0 marks a keyboard-activated click (Enter/Space); restore focus
    // to the trigger so keyboard users are not stranded after the menu unmounts.
    // Restore BEFORE onSelect: a destructive option (e.g. 隱藏書籍) can unmount
    // the trigger, and focusing an about-to-be-removed node strands focus on
    // <body>.
    const viaKeyboard = e.detail === 0;
    if (viaKeyboard) restoreTriggerFocus();
    item.onSelect();
    setOpenState(false);
  };

  return (
    <div className="moo-overflow">
      <button
        ref={triggerRef}
        type="button"
        aria-label="更多選項"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleTriggerClick}
        className={triggerClass}
      >
        <MoreHorizontal size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="書籍選項"
            className="moo-overflow__menu"
            onKeyDown={handleMenuKeyDown}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={(e) => handleItemClick(e, item)}
                className="moo-overflow__item"
              >
                {item.label}
              </button>
            ))}
          </div>,
          portalContainer,
        )}
    </div>
  );
}
