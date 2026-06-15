import React, { useRef, useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";

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

/**
 * Reusable "⋯" (horizontal meatballs) overflow menu (Extension).
 *
 * Anchored, absolutely-positioned menu. Closes on outside click, Escape, or
 * item select. All listeners are attached only while open and removed on
 * cleanup. Designed to host multiple items; currently used with one.
 */
export function OverflowMenu({ items, onOpenChange, tone = "overlay" }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerStyle = triggerStyleFor(tone);

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
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-label="更多選項"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleTriggerClick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
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
      {open && (
        <div
          role="menu"
          aria-label="書籍選項"
          style={{
            position: "absolute",
            top: 32,
            right: 0,
            minWidth: 120,
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 60,
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
        </div>
      )}
    </div>
  );
}
