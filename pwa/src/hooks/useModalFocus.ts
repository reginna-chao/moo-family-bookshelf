import { useEffect, type RefObject } from "react";
// Twin: extension/src/dialog/PublicShareDialog.tsx (useEscapeToClose / useFocusTrap / opener effect) — keep behaviour in step.

/** Focusable descendants, in DOM order, that Tab can reach. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);
}

function useFocusTrap(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (items.length === 0) return;
      const active = document.activeElement;
      // Focus starts on the container itself (tabIndex=-1), i.e. outside items:
      // Shift+Tab from there must wrap to the last item, not escape the modal.
      const focusIsInside = items.some((el) => el === active);
      const atEdge = e.shiftKey
        ? active === items[0] || !focusIsInside
        : active === items[items.length - 1];
      if (!atEdge) return;
      e.preventDefault();
      const target = e.shiftKey ? items[items.length - 1] : items[0];
      target.focus();
    };
    container.addEventListener("keydown", handler);
    return () => {
      container.removeEventListener("keydown", handler);
    };
  }, [containerRef]);
}

function useFocusInOut(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const opener = document.activeElement;
    containerRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [containerRef]);
}

/**
 * Keyboard model for a modal panel (PWA): Escape calls `onClose` (window
 * listener), Tab / Shift+Tab wrap inside `containerRef` (`aria-modal="true"`
 * only hints assistive tech, so the keyboard would otherwise walk the page
 * behind the overlay), and focus moves to the container on mount and back to
 * the element that opened it on unmount. The container needs `tabIndex={-1}`.
 * Every listener is removed on unmount.
 */
export function useModalFocus(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEscapeToClose(onClose);
  useFocusTrap(containerRef);
  useFocusInOut(containerRef);
}
