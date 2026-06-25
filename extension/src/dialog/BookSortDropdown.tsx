import React, { useRef, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownWideNarrow } from "lucide-react";
import type { BookSortMode } from "./sortBooks";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
import { useIsMobile } from "../hooks/useIsMobile";

export interface BookSortDropdownProps {
  value: BookSortMode;
  onChange: (mode: BookSortMode) => void;
}

const OPTIONS: Array<{ value: BookSortMode; label: string }> = [
  { value: "default", label: "預設順序" },
  { value: "title", label: "依書名排序" },
  { value: "author", label: "依作者排序" },
];

// Above the Dialog overlay (#moo-family-bookshelf-dialog uses z-index 100000).
const MENU_Z_INDEX = 100001;

/**
 * Custom sort dropdown (Extension): an icon trigger that opens a portaled
 * listbox of sort modes. The panel is portaled to `document.body` and positioned
 * with `position: fixed` so the Dialog's `overflow: hidden` cannot clip it.
 * Closes on outside click, Escape, scroll, or resize — all listeners attached
 * only while open and removed on cleanup.
 */
export function BookSortDropdown({ value, onChange }: BookSortDropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const triggerSize = isMobile ? 32 : 40;
  const isActive = value !== "default";
  const { position, place, reset } = useAnchoredPosition();

  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open) {
      reset();
      return;
    }
    place(triggerRef.current, menuRef.current);
  }, [open, place, reset]);

  useDismissableMenu({ isOpen: open, onClose: close, triggerRef, menuRef });

  const handleSelect = (mode: BookSortMode) => {
    onChange(mode);
    close();
  };

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="排序方式"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: triggerSize,
          height: triggerSize,
          border: isActive ? "1px solid #2563eb" : "1px solid #e2e8f0",
          borderRadius: 8,
          background: isActive ? "#eff6ff" : "white",
          color: isActive ? "#2563eb" : "#94a3b8",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <ArrowDownWideNarrow size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="排序方式選單"
            style={{
              position: "fixed",
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
              minWidth: 140,
              background: "white",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              zIndex: MENU_Z_INDEX,
              overflow: "hidden",
            }}
          >
            {OPTIONS.map((opt) => {
              const selected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => handleSelect(opt.value)}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 12px",
                    border: "none",
                    background: selected ? "#eff6ff" : "transparent",
                    color: selected ? "#2563eb" : "#334155",
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "left",
                    whiteSpace: "nowrap",
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
