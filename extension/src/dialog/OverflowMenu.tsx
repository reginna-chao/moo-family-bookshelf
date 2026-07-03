import React, { useRef, useLayoutEffect, useState } from "react";
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
export function OverflowMenu({ items, onOpenChange, tone = "overlay" }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const portalContainer = usePortalContainer();
  const { position, place, reset } = useAnchoredPosition();

  const triggerClass = [
    "moo-overflow__trigger",
    isMobile ? "moo-overflow__trigger--mobile" : "",
    tone === "plain" ? "moo-overflow__trigger--plain" : "moo-overflow__trigger--overlay",
  ]
    .filter(Boolean)
    .join(" ");

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (onOpenChange) onOpenChange(next);
  };

  const close = () => setOpenState(false);

  useLayoutEffect(() => {
    if (!open) {
      reset();
      return;
    }
    place(triggerRef.current, menuRef.current);
  }, [open, place, reset]);

  useDismissableMenu({ isOpen: open, onClose: close, triggerRef, menuRef });

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
