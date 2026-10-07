import { useEffect, useRef, type RefObject } from "react";

export interface DismissableMenuOptions {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
  /** On Escape, refocus the trigger if focus was in the menu / trigger or fell to the document; never on
   *  outside click / scroll / resize. Default true (ARIA APG). Twin: .claude/rules/frontend.md. */
  returnFocusOnEscape?: boolean;
}

/** True when the event's path starts inside the trigger or the menu (must not dismiss); composedPath()
 *  sees past the shadow host `e.target` is retargeted to. Twin: .claude/rules/frontend.md. */
function eventStartedInMenu(
  e: Event,
  trigger: HTMLElement | null,
  menu: HTMLElement | null,
): boolean {
  const path = e.composedPath();
  return (
    (!!trigger && path.includes(trigger)) || (!!menu && path.includes(menu))
  );
}

/** True when a document-level key event has no focused element behind it (the focused option
 *  unmounted, or nothing was focused): focus fell to the document, not to a chosen control. */
function focusIsNowhere(target: EventTarget | null): boolean {
  return (
    target === document ||
    target === document.body ||
    target === document.documentElement
  );
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
  returnFocusOnEscape = true,
}: DismissableMenuOptions): void {
  // Store the latest onClose / returnFocusOnEscape so listeners always read
  // the current values without re-subscribing on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocusOnEscape);
  returnFocusRef.current = returnFocusOnEscape;

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(e: MouseEvent) {
      // Clicks inside the menu/trigger must not close it before onClick fires.
      if (eventStartedInMenu(e, triggerRef.current, menuRef.current)) return;
      onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Reclaim only focus the menu owned or that fell to the document (a control Tabbed to keeps
      // it); decided before onClose, which may unmount the menu.
      const reclaim =
        returnFocusRef.current &&
        (eventStartedInMenu(e, triggerRef.current, menuRef.current) ||
          focusIsNowhere(e.target));
      onCloseRef.current();
      if (reclaim) triggerRef.current?.focus();
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

    // Shadow-tree scrolls never reach `window` (composed: false): also capture on the trigger's
    // ShadowRoot; the window listener stays for light DOM. Twin: .claude/rules/frontend.md.
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
