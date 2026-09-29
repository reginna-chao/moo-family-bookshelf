import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";

interface HarnessProps {
  isOpen: boolean;
  onClose: () => void;
  dismissOnScroll?: boolean;
}

/**
 * Drives the hook with real DOM refs. The menu is rendered only while open,
 * like every PWA consumer; the "outside" node is a sibling scroll container
 * that lives outside both the trigger and the menu subtree.
 */
function Harness({ isOpen, onClose, dismissOnScroll }: HarnessProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissableMenu({ isOpen, onClose, triggerRef, menuRef, dismissOnScroll });
  return (
    <>
      <button ref={triggerRef} data-testid="trigger">
        <span data-testid="trigger-icon">icon</span>
      </button>
      {isOpen && (
        <div ref={menuRef} data-testid="menu">
          <button data-testid="menu-item">option</button>
        </div>
      )}
      <div data-testid="outside">outside</div>
    </>
  );
}

/** One way of firing an event at the page, keyed by a readable name. */
interface EventCase {
  name: string;
  fire: () => void;
}

// fireEvent.scroll defaults to a NON-bubbling event, like a real element
// scroll — only the hook's capture-phase window listener can observe it.
const outsideMouseDown: EventCase = {
  name: "outside mousedown",
  fire: () => fireEvent.mouseDown(screen.getByTestId("outside")),
};
const escapeKey: EventCase = {
  name: "Escape keydown",
  fire: () => fireEvent.keyDown(document, { key: "Escape" }),
};
const windowScroll: EventCase = {
  name: "window scroll",
  fire: () => fireEvent.scroll(window),
};
const documentScroll: EventCase = {
  name: "document scroll",
  fire: () => fireEvent.scroll(document),
};
const outsideContainerScroll: EventCase = {
  name: "scroll of a container outside the menu",
  fire: () => fireEvent.scroll(screen.getByTestId("outside")),
};
const windowResize: EventCase = {
  name: "window resize",
  fire: () => fireEvent(window, new Event("resize")),
};

const ALWAYS_DISMISSING = [outsideMouseDown, escapeKey];
const SCROLL_AND_RESIZE = [
  windowScroll,
  documentScroll,
  outsideContainerScroll,
  windowResize,
];
const ALL_DISMISSING = [...ALWAYS_DISMISSING, ...SCROLL_AND_RESIZE];

afterEach(cleanup);

describe("useDismissableMenu", () => {
  describe("while open", () => {
    it.each(ALWAYS_DISMISSING)("calls onClose once on $name", ({ fire }) => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fire();

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each<EventCase>([
      {
        name: "mousedown on the menu container",
        fire: () => fireEvent.mouseDown(screen.getByTestId("menu")),
      },
      {
        name: "mousedown on an option inside the menu",
        fire: () => fireEvent.mouseDown(screen.getByTestId("menu-item")),
      },
      {
        name: "mousedown on the trigger",
        fire: () => fireEvent.mouseDown(screen.getByTestId("trigger")),
      },
      {
        name: "mousedown on a child of the trigger",
        fire: () => fireEvent.mouseDown(screen.getByTestId("trigger-icon")),
      },
      {
        name: "Enter keydown",
        fire: () => fireEvent.keyDown(document, { key: "Enter" }),
      },
      {
        name: "Tab keydown",
        fire: () => fireEvent.keyDown(document, { key: "Tab" }),
      },
    ])("does not call onClose on $name", ({ fire }) => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} />);

      fire();

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  // Inline dropdowns scroll along with their trigger, and mobile address-bar
  // collapse fires resize — so by default neither may dismiss the menu.
  describe("dismissOnScroll = false (default)", () => {
    it.each(SCROLL_AND_RESIZE)(
      "does not call onClose on $name, while Escape still does",
      ({ fire }) => {
        const onClose = vi.fn();
        render(<Harness isOpen onClose={onClose} />);

        fire();
        expect(onClose).not.toHaveBeenCalled();

        // Positive companion: the hook IS subscribed; only scroll/resize are
        // ignored, so the negative assertion above cannot pass vacuously.
        escapeKey.fire();
        expect(onClose).toHaveBeenCalledTimes(1);
      },
    );

    it("treats an explicit dismissOnScroll={false} the same as the default", () => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} dismissOnScroll={false} />);

      windowScroll.fire();
      windowResize.fire();

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("dismissOnScroll = true", () => {
    it.each(ALL_DISMISSING)("calls onClose once on $name", ({ fire }) => {
      const onClose = vi.fn();
      render(<Harness isOpen onClose={onClose} dismissOnScroll />);

      fire();

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // A scroll that starts inside the menu (its own scrollable option list) or
    // the trigger must keep the menu open so lower options stay reachable.
    it.each<{ name: string; testId: string; bubbles: boolean }>([
      { name: "the menu container", testId: "menu", bubbles: false },
      {
        name: "an option inside the menu",
        testId: "menu-item",
        bubbles: false,
      },
      { name: "an option inside the menu", testId: "menu-item", bubbles: true },
      { name: "the trigger", testId: "trigger", bubbles: false },
    ])(
      "does not call onClose on a scroll of $name (bubbles: $bubbles)",
      ({ testId, bubbles }) => {
        const onClose = vi.fn();
        render(<Harness isOpen onClose={onClose} dismissOnScroll />);

        fireEvent(screen.getByTestId(testId), new Event("scroll", { bubbles }));

        expect(onClose).not.toHaveBeenCalled();
      },
    );
  });

  describe("while closed", () => {
    it.each(ALL_DISMISSING)("does not call onClose on $name", ({ fire }) => {
      const onClose = vi.fn();
      render(<Harness isOpen={false} onClose={onClose} dismissOnScroll />);

      fire();

      expect(onClose).not.toHaveBeenCalled();
    });

    it("starts listening once isOpen turns true", () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <Harness isOpen={false} onClose={onClose} dismissOnScroll />,
      );

      escapeKey.fire();
      expect(onClose).not.toHaveBeenCalled();

      rerender(<Harness isOpen onClose={onClose} dismissOnScroll />);
      escapeKey.fire();
      windowScroll.fire();

      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });

  // Each case first proves the listener is live (positive companion), then
  // proves the same event is ignored after the teardown under test.
  describe("listener removal", () => {
    it.each(ALL_DISMISSING)(
      "stops reacting to $name after isOpen turns false",
      ({ fire }) => {
        const onClose = vi.fn();
        const { rerender } = render(
          <Harness isOpen onClose={onClose} dismissOnScroll />,
        );

        fire();
        expect(onClose).toHaveBeenCalledTimes(1);

        rerender(<Harness isOpen={false} onClose={onClose} dismissOnScroll />);
        fire();

        expect(onClose).toHaveBeenCalledTimes(1);
      },
    );

    it.each(
      // After unmount the "outside" node is gone, so fire at document.body.
      ALL_DISMISSING.map<EventCase>((c) =>
        c === outsideMouseDown
          ? {
              name: "a document mousedown",
              fire: () => fireEvent.mouseDown(document.body),
            }
          : c === outsideContainerScroll
            ? {
                name: "a body scroll",
                fire: () => fireEvent.scroll(document.body),
              }
            : c,
      ),
    )("stops reacting to $name after unmount", ({ fire }) => {
      const onClose = vi.fn();
      const { unmount } = render(
        <Harness isOpen onClose={onClose} dismissOnScroll />,
      );

      fire();
      expect(onClose).toHaveBeenCalledTimes(1);

      unmount();
      fire();

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("drops the scroll and resize listeners when dismissOnScroll turns off while open", () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <Harness isOpen onClose={onClose} dismissOnScroll />,
      );

      windowScroll.fire();
      windowResize.fire();
      expect(onClose).toHaveBeenCalledTimes(2);

      rerender(<Harness isOpen onClose={onClose} dismissOnScroll={false} />);
      windowScroll.fire();
      windowResize.fire();
      expect(onClose).toHaveBeenCalledTimes(2);

      // Mousedown / Escape listeners are re-attached, not lost.
      escapeKey.fire();
      expect(onClose).toHaveBeenCalledTimes(3);
    });
  });

  describe("latest onClose", () => {
    it("calls the most recent onClose after a rerender with a new callback", () => {
      const onCloseA = vi.fn();
      const onCloseB = vi.fn();
      const { rerender } = render(
        <Harness isOpen onClose={onCloseA} dismissOnScroll />,
      );

      rerender(<Harness isOpen onClose={onCloseB} dismissOnScroll />);
      escapeKey.fire();
      outsideMouseDown.fire();
      windowScroll.fire();

      expect(onCloseB).toHaveBeenCalledTimes(3);
      expect(onCloseA).not.toHaveBeenCalled();
    });
  });
});
