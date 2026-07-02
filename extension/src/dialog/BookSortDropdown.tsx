import React, { useId, useRef, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownWideNarrow } from "lucide-react";
import type { BookSortMode } from "./sortBooks";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePortalContainer } from "./PortalContainerContext";

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

// Clamp an index to the option list bounds (↑/↓ stop at edges, no wrap-around).
function clampIndex(index: number): number {
  if (index < 0) return 0;
  if (index > OPTIONS.length - 1) return OPTIONS.length - 1;
  return index;
}

// Selected (blue) wins; a keyboard-active but unselected option gets a neutral
// grey highlight; everything else is transparent. Keeps the existing selected
// colour semantics untouched.
function optionBackground(selected: boolean, active: boolean): string {
  if (selected) return "#eff6ff";
  if (active) return "#f1f5f9";
  return "transparent";
}

/**
 * Custom sort dropdown (Extension): an icon trigger that opens a portaled
 * listbox of sort modes. The panel is portaled into the dialog's portal
 * container (the Shadow Root in production, `document.body` on the dev page) and
 * positioned with `position: fixed` so the Dialog's `overflow: hidden` cannot
 * clip it. Closes on outside click, Escape, scroll, or resize — all listeners
 * attached only while open and removed on cleanup.
 */
export function BookSortDropdown({ value, onChange }: BookSortDropdownProps) {
  const [open, setOpen] = useState(false);
  // Which option the keyboard cursor points at (aria-activedescendant target).
  const [activeValue, setActiveValue] = useState<BookSortMode>(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Tracks whether the menu was ever opened, so the close-effect restores focus
  // to the trigger only after a real open→close — never on the initial mount.
  const wasOpenRef = useRef(false);
  const isMobile = useIsMobile();
  const portalContainer = usePortalContainer();
  const triggerSize = isMobile ? 32 : 40;
  const isActive = value !== "default";
  const { position, place, reset } = useAnchoredPosition();
  const optionId = useId();

  const optionIdFor = (mode: BookSortMode) => `${optionId}-${mode}`;

  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open) {
      reset();
      return;
    }
    place(triggerRef.current, menuRef.current);
  }, [open, place, reset]);

  // Restore focus to the trigger after a real open→close transition so Esc,
  // outside-click, and selection all leave focus in a predictable place. The
  // wasOpenRef guard prevents stealing focus on the initial mount.
  useLayoutEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      triggerRef.current?.focus();
    }
  }, [open]);

  // Seed the active option and move focus into the listbox only once it is
  // positioned (and therefore visibility:visible) — focusing a visibility:hidden
  // element is a no-op in real browsers, which would leave the keyboard handler
  // unreachable on first open.
  useLayoutEffect(() => {
    if (!open || !position) return;
    setActiveValue(value);
    menuRef.current?.focus();
  }, [open, position, value]);

  useDismissableMenu({ isOpen: open, onClose: close, triggerRef, menuRef });

  const handleSelect = (mode: BookSortMode) => {
    onChange(mode);
    close();
  };

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
            tabIndex={-1}
            aria-activedescendant={optionIdFor(activeValue)}
            onKeyDown={handleListKeyDown}
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
              outline: "none",
            }}
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
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 12px",
                    border: "none",
                    background: optionBackground(selected, active),
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
          portalContainer,
        )}
    </div>
  );
}
