import { useEffect, useRef, type RefObject } from "react";

export interface DismissableMenuOptions {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
}

/**
 * Returns true when the event's propagation path starts inside the trigger or
 * the menu. Used to decide when NOT to dismiss (clicks/scrolls that belong to
 * the menu itself). composedPath() pierces the shadow boundary — at the document
 * level `e.target` is retargeted to the shadow host, so `menu.contains(e.target)`
 * would report an inside interaction as "outside"; composedPath() returns the
 * real inner nodes and works identically in light DOM (e.g. BookSortDropdown
 * portaling to body).
 */
function eventStartedInMenu(
  e: Event,
  trigger: HTMLElement | null,
  menu: HTMLElement | null,
): boolean {
  const path = e.composedPath();
  return (!!trigger && path.includes(trigger)) || (!!menu && path.includes(menu));
}

/**
 * Encapsulates the dismissal side effects shared by portaled popup menus
 * (Extension): while open, closes the menu on outside click, Escape, scroll
 * (capture phase), or resize. Scroll is observed both at `window` (dev page /
 * light DOM and window-level scroll) and, when the trigger lives inside an open
 * shadow root, on that `ShadowRoot` in capture phase — `scroll` events are
 * `composed: false`, so a scroll inside the shadow tree never reaches `window`;
 * the shadow root is the top of the propagation path for those events.
 *
 * Scroll-to-dismiss only closes the menu when the page/panels BEHIND it scroll:
 * scrolls whose target is inside the menu (or the trigger) are ignored via
 * composedPath(), so the menu's own `overflow-y: auto` list can be scrolled to
 * reach lower options without dismissing. Resize still closes unconditionally.
 * All listeners are attached only while open and removed together on cleanup.
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
      // Clicks inside the menu/trigger must not close it before onClick fires.
      if (eventStartedInMenu(e, triggerRef.current, menuRef.current)) return;
      onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onCloseRef.current();
    }
    function handleClose() {
      onCloseRef.current();
    }
    function handleScroll(e: Event) {
      // Ignore scrolls originating inside the menu's own scrollable list (or the
      // trigger); only dismiss when the page/panels BEHIND the menu scroll.
      if (eventStartedInMenu(e, triggerRef.current, menuRef.current)) return;
      onCloseRef.current();
    }

    // A scroll inside an open shadow tree does not reach `window` (scroll events
    // are composed: false). Also listen on the trigger's ShadowRoot in capture
    // phase so scrolling the dialog's panels dismisses the menu; keep the window
    // listener for the dev page / light DOM and window-level scroll.
    const scrollRoot = triggerRef.current?.getRootNode();
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleClose);
    if (scrollRoot instanceof ShadowRoot) {
      scrollRoot.addEventListener("scroll", handleScroll, true);
    }
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleClose);
      if (scrollRoot instanceof ShadowRoot) {
        scrollRoot.removeEventListener("scroll", handleScroll, true);
      }
    };
    // Refs are stable and onClose is read via onCloseRef; only isOpen should re-subscribe listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
}
