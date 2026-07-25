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

// Selected (blue) wins; a keyboard-active but unselected option gets a neutral
// grey highlight; everything else is transparent. Keeps the existing selected
// colour semantics untouched. Mirrors the .moo-sort__option modifier rules.
function optionClass(selected: boolean, active: boolean): string {
  if (selected) return "moo-sort__option moo-sort__option--selected";
  if (active) return "moo-sort__option moo-sort__option--active";
  return "moo-sort__option";
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
  const isActive = value !== "default";
  const { position, place, reset } = useAnchoredPosition();
  const optionId = useId();

  const triggerClass = [
    "moo-button moo-button--ghost-icon moo-button--icon moo-sort__trigger",
    isMobile ? "moo-sort__trigger--mobile" : "",
    isActive ? "moo-sort__trigger--active" : "",
  ]
    .filter(Boolean)
    .join(" ");

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
    <div className="moo-sort">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="排序方式"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClass}
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
            className="moo-sort__menu"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
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
                  className={optionClass(selected, active)}
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
