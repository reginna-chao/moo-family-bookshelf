import { useEffect, useRef, type RefObject } from "react";

export interface DismissableMenuOptions {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
}

/**
 * Encapsulates the dismissal side effects shared by portaled popup menus
 * (Extension): while open, closes the menu on outside click, Escape, scroll
 * (capture phase), or resize. All four listeners are attached only while open
 * and removed together on cleanup.
 */
export function useDismissableMenu({
  isOpen,
  onClose,
  triggerRef,
  menuRef,
}: DismissableMenuOptions): void {
  // Store the latest onClose so listeners always call the current callback
  // without re-subscribing on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(e: MouseEvent) {
      if (isInsideMenu(e.target, triggerRef.current, menuRef.current)) return;
      onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onCloseRef.current();
    }
    function handleClose() {
      onCloseRef.current();
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleClose, true);
    window.addEventListener("resize", handleClose);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleClose, true);
      window.removeEventListener("resize", handleClose);
    };
    // Refs are stable and onClose is read via onCloseRef; only isOpen should re-subscribe listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
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
