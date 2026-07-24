import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  renderHook,
} from "@testing-library/react";
import { useRef, createRef, type RefObject } from "react";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";

interface HarnessProps {
  isOpen: boolean;
  onClose: () => void;
}

function Harness({ isOpen, onClose }: HarnessProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissableMenu({ isOpen, onClose, triggerRef, menuRef });
  return (
    <>
      <button ref={triggerRef} data-testid="trigger">
        trigger
      </button>
      {isOpen && (
        <div ref={menuRef} data-testid="menu">
          {/* Mirrors the menu's own scrollable option list; a wheel/scroll here
              must NOT dismiss the menu. */}
          <button data-testid="menu-item">option</button>
        </div>
      )}
      {/* A sibling scroll container that lives OUTSIDE the menu subtree. */}
      <div data-testid="outside">outside</div>
    </>
  );
}

afterEach(cleanup);

describe("useDismissableMenu", () => {
  describe("when open", () => {
    it("calls onClose once on an outside mousedown", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent.mouseDown(screen.getByTestId("outside"));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose on a mousedown inside the menu", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent.mouseDown(screen.getByTestId("menu"));

      expect(onClose).not.toHaveBeenCalled();
    });

    it("does not call onClose on a mousedown on the trigger", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent.mouseDown(screen.getByTestId("trigger"));

      expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onClose on Escape keydown", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose on a non-Escape keydown", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent.keyDown(document, { key: "Enter" });

      expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onClose on a window scroll event (capture phase)", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      window.dispatchEvent(new Event("scroll"));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose on a window resize event", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      window.dispatchEvent(new Event("resize"));

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // The scroll-to-dismiss handler is origin-aware: a scroll whose composedPath
  // includes the menu (its own overflow-y:auto list) or the trigger must NOT
  // close the menu, so lower options stay reachable by wheel. Only scrolls of
  // the page/panels BEHIND the menu dismiss it. Escape/outside-click/resize are
  // unaffected.
  describe("scroll-to-dismiss (origin-aware)", () => {
    it("keeps the menu open on a scroll originating inside the menu's list", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      // bubbles:true so the capture-phase window listener sees it and the
      // composedPath climbs through the menu (matching a real wheel-scroll on
      // an option row inside the scrollable list).
      fireEvent(
        screen.getByTestId("menu-item"),
        new Event("scroll", { bubbles: true }),
      );

      expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps the menu open on a scroll dispatched on the menu element itself", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent(
        screen.getByTestId("menu"),
        new Event("scroll", { bubbles: true }),
      );

      expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps the menu open on a scroll originating on the trigger", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent(
        screen.getByTestId("trigger"),
        new Event("scroll", { bubbles: true }),
      );

      expect(onClose).not.toHaveBeenCalled();
    });

    it("closes the menu on a scroll originating from a sibling container outside the menu", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fireEvent(
        screen.getByTestId("outside"),
        new Event("scroll", { bubbles: true }),
      );

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("when closed", () => {
    it("does not register any dismissal listeners", () => {
      const onClose = vi.fn();
      render(<Harness isOpen={false} onClose={onClose} />);

      fireEvent.mouseDown(screen.getByTestId("outside"));
      fireEvent.keyDown(document, { key: "Escape" });
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("removes all listeners on unmount", () => {
      const onClose = vi.fn();
      const { unmount } = render(<Harness isOpen onClose={onClose} />);

      onClose.mockClear();
      unmount();

      fireEvent.mouseDown(document.body);
      fireEvent.keyDown(document, { key: "Escape" });
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));

      expect(onClose).not.toHaveBeenCalled();
    });

    it("removes all listeners when isOpen transitions to false", () => {
      const onClose = vi.fn();
      const { rerender } = render(<Harness isOpen onClose={onClose} />);

      rerender(<Harness isOpen={false} onClose={onClose} />);
      onClose.mockClear();

      fireEvent.mouseDown(screen.getByTestId("outside"));
      fireEvent.keyDown(document, { key: "Escape" });
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("latest callback via ref", () => {
    it("invokes the most recent onClose without needing to re-subscribe", () => {
      const onCloseA = vi.fn();
      const onCloseB = vi.fn();
      const { rerender } = render(<Harness isOpen onClose={onCloseA} />);

      rerender(<Harness isOpen onClose={onCloseB} />);
      fireEvent.keyDown(document, { key: "Escape" });

      expect(onCloseB).toHaveBeenCalledTimes(1);
      expect(onCloseA).not.toHaveBeenCalled();
    });
  });

  // Regression coverage for the shadow-root scroll listener. The dialog is
  // injected into an OPEN shadow root; `scroll` events are `composed: false`,
  // so a scroll originating inside the shadow tree never crosses the shadow
  // boundary to reach `window`. The window-only listener therefore missed those
  // scrolls and the menu stayed open. The hook now also attaches a capture-phase
  // `scroll` listener on the trigger's ShadowRoot (the top of the propagation
  // path for those events). These tests drive the hook with real DOM refs so
  // that `triggerRef.current.getRootNode()` genuinely returns a `ShadowRoot`.
  describe("shadow root scroll (composed: false)", () => {
    // Tracks hosts created per test so afterEach can detach them and let the
    // shadow tree (and any listeners the hook attached to it) be released.
    let hosts: HTMLElement[] = [];

    function mountInShadowRoot(onClose: () => void) {
      const host = document.createElement("div");
      document.body.appendChild(host);
      hosts.push(host);
      const shadowRoot = host.attachShadow({ mode: "open" });

      // Trigger lives INSIDE the shadow root, so getRootNode() -> shadowRoot.
      const trigger = document.createElement("button");
      shadowRoot.appendChild(trigger);
      // A scrollable panel inside the shadow tree; scroll events from here are
      // composed: false and do not reach window.
      const innerScrollContainer = document.createElement("div");
      shadowRoot.appendChild(innerScrollContainer);
      const menu = document.createElement("div");
      shadowRoot.appendChild(menu);
      // An option row inside the menu's own scrollable list; scrolling here must
      // NOT dismiss the menu even though the event also stays inside the shadow.
      const innerMenuItem = document.createElement("button");
      menu.appendChild(innerMenuItem);

      const triggerRef = createRef<HTMLElement>() as RefObject<HTMLElement>;
      const menuRef = createRef<HTMLElement>() as RefObject<HTMLElement>;
      triggerRef.current = trigger;
      menuRef.current = menu;

      const view = renderHook(
        ({ isOpen }: { isOpen: boolean }) =>
          useDismissableMenu({ isOpen, onClose, triggerRef, menuRef }),
        { initialProps: { isOpen: true } },
      );

      return { view, shadowRoot, innerScrollContainer, innerMenuItem };
    }

    afterEach(() => {
      for (const host of hosts) host.remove();
      hosts = [];
    });

    it("calls onClose on a scroll originating inside the shadow tree", () => {
      const onClose = vi.fn();
      const { innerScrollContainer } = mountInShadowRoot(onClose);

      // bubbles: false + composed: false mirrors a real element scroll; this
      // event never reaches window, so only the ShadowRoot listener can catch it.
      innerScrollContainer.dispatchEvent(
        new Event("scroll", { bubbles: false }),
      );

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps the menu open on a scroll originating inside the menu within the shadow tree", () => {
      const onClose = vi.fn();
      const { innerMenuItem } = mountInShadowRoot(onClose);

      // Same shadow-root listener catches it, but composedPath climbs through the
      // menu, so the origin-aware handler must ignore it.
      innerMenuItem.dispatchEvent(new Event("scroll", { bubbles: true }));

      expect(onClose).not.toHaveBeenCalled();
    });

    it("still calls onClose on a window scroll when the trigger is in light DOM", () => {
      const onClose = vi.fn();
      const triggerRef = createRef<HTMLElement>() as RefObject<HTMLElement>;
      const menuRef = createRef<HTMLElement>() as RefObject<HTMLElement>;
      const trigger = document.createElement("button");
      const menu = document.createElement("div");
      document.body.appendChild(trigger);
      document.body.appendChild(menu);
      triggerRef.current = trigger;
      menuRef.current = menu;

      renderHook(() =>
        useDismissableMenu({ isOpen: true, onClose, triggerRef, menuRef }),
      );

      window.dispatchEvent(new Event("scroll"));

      expect(onClose).toHaveBeenCalledTimes(1);

      trigger.remove();
      menu.remove();
    });

    it("removes the shadow-root scroll listener on unmount", () => {
      const onClose = vi.fn();
      const { view, innerScrollContainer } = mountInShadowRoot(onClose);

      view.unmount();
      onClose.mockClear();

      innerScrollContainer.dispatchEvent(
        new Event("scroll", { bubbles: false }),
      );

      expect(onClose).not.toHaveBeenCalled();
    });

    it("removes the shadow-root scroll listener when isOpen transitions to false", () => {
      const onClose = vi.fn();
      const { view, innerScrollContainer } = mountInShadowRoot(onClose);

      view.rerender({ isOpen: false });
      onClose.mockClear();

      innerScrollContainer.dispatchEvent(
        new Event("scroll", { bubbles: false }),
      );

      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
