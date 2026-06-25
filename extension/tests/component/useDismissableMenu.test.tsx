import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useRef } from "react";
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
          menu
        </div>
      )}
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
});
