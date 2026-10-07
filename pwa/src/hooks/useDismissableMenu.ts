import { useEffect, useRef, type RefObject } from "react";

export interface DismissableMenuOptions {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
  /** Also close on page scroll (capture phase) and window resize, for portaled / `position: fixed`
   *  menus that would detach from their trigger. Default false. */
  dismissOnScroll?: boolean;
  /** On Escape, refocus the trigger if focus was in the menu / trigger or fell to the document; never on
   *  outside click / scroll / resize. Default true (ARIA APG). Twin: .claude/rules/frontend.md. */
  returnFocusOnEscape?: boolean;
}

/** True when the event's path starts inside the trigger or the menu (must not dismiss). No shadow DOM
 *  here, so composedPath() is a plain ancestor walk, kept to match the Extension hook. */
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
 * Dismissal side effects shared by the PWA's popup menus (modelled on
 * `extension/src/hooks/useDismissableMenu.ts`, minus its ShadowRoot handling):
 * while open, closes the menu on a mousedown outside the trigger and menu, and
 * on Escape.
 *
 * Scroll / resize dismissal is opt-in via `dismissOnScroll`. The inline
 * dropdowns are `absolute`-positioned next to their trigger, so they scroll
 * along with the content and stay attached; and on mobile the address bar
 * collapsing mid-scroll fires `resize`, which would close them for no reason.
 * Only a body-portaled `position: fixed` menu (OverflowMenu) detaches from its
 * trigger when the page moves, so only it turns this on. Scrolls that start
 * inside the menu or trigger never dismiss, so a scrollable menu list stays
 * usable. All listeners are attached only while open and removed on cleanup.
 */
export function useDismissableMenu({
  isOpen,
  onClose,
  triggerRef,
  menuRef,
  dismissOnScroll = false,
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

    function handleInsideAwareClose(e: Event) {
      // Clicks/scrolls inside the menu or trigger must not close it (a click
      // must reach the option's onClick; a menu list must stay scrollable).
      if (eventStartedInMenu(e, triggerRef.current, menuRef.current)) return;
      onCloseRef.current();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Reclaim only focus the menu owned or that fell to the document, never a control the user
      // Tabbed to. Decided before onClose, which may unmount the menu.
      const reclaim =
        returnFocusRef.current &&
        (eventStartedInMenu(e, triggerRef.current, menuRef.current) ||
          focusIsNowhere(e.target));
      onCloseRef.current();
      if (reclaim) triggerRef.current?.focus();
    }
    function handleResize() {
      onCloseRef.current();
    }

    document.addEventListener("mousedown", handleInsideAwareClose);
    document.addEventListener("keydown", handleKeyDown);
    if (dismissOnScroll) {
      window.addEventListener("scroll", handleInsideAwareClose, true);
      window.addEventListener("resize", handleResize);
    }
    return () => {
      document.removeEventListener("mousedown", handleInsideAwareClose);
      document.removeEventListener("keydown", handleKeyDown);
      if (dismissOnScroll) {
        window.removeEventListener("scroll", handleInsideAwareClose, true);
        window.removeEventListener("resize", handleResize);
      }
    };
    // Refs are stable and onClose is read via a ref: only isOpen / dismissOnScroll re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, dismissOnScroll]);
}
