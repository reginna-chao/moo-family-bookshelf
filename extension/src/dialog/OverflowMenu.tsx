import React, { useRef, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
import { useIsMobile } from "../hooks/useIsMobile";

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

interface TriggerStyle {
  background: string;
  color: string;
}

function triggerStyleFor(tone: "overlay" | "plain"): TriggerStyle {
  if (tone === "plain") {
    return { background: "transparent", color: "#64748b" };
  }
  return { background: "rgba(15, 23, 42, 0.55)", color: "white" };
}

// Above the Dialog overlay (#moo-family-bookshelf-dialog uses z-index 100000).
const MENU_Z_INDEX = 100001;

/**
 * Reusable "⋯" (horizontal meatballs) overflow menu (Extension).
 *
 * The panel is portaled to `document.body` and positioned with `position: fixed`
 * from the trigger's bounding rect, so the Dialog's `overflow: hidden` cannot
 * clip it. Closes on outside click, Escape, item select, scroll, or resize. All
 * listeners are attached only while open and removed on cleanup.
 */
export function OverflowMenu({ items, onOpenChange, tone = "overlay" }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerStyle = triggerStyleFor(tone);
  const isMobile = useIsMobile();
  const triggerSize = isMobile ? 32 : 28;
  const { position, place, reset } = useAnchoredPosition();

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
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="更多選項"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleTriggerClick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: triggerSize,
          height: triggerSize,
          border: "none",
          borderRadius: 6,
          background: triggerStyle.background,
          color: triggerStyle.color,
          cursor: "pointer",
          padding: 0,
        }}
      >
        <MoreHorizontal size={16} />
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
              minWidth: 120,
              background: "white",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              zIndex: MENU_Z_INDEX,
              overflow: "hidden",
            }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={(e) => handleItemClick(e, item)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px 12px",
                  border: "none",
                  background: "transparent",
                  color: "#334155",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "left",
                  whiteSpace: "nowrap",
                }}
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
