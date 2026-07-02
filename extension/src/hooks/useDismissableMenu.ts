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
      // This listener lives on `document`, but the menu may be portaled into an
      // open shadow root. At the document level `e.target` is retargeted to the
      // shadow host, so `menu.contains(e.target)` would report a click inside the
      // menu as "outside" and close it before onClick fires. composedPath()
      // pierces the shadow boundary and returns the real inner nodes; it also
      // works identically in light DOM (e.g. BookSortDropdown portaling to body).
      const path = e.composedPath();
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if ((trigger && path.includes(trigger)) || (menu && path.includes(menu))) return;
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
