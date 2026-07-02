import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OverflowMenu, type OverflowMenuItem } from "@/dialog/OverflowMenu";
import { PortalContainerContext } from "@/dialog/PortalContainerContext";
import { useIsMobile } from "@/hooks/useIsMobile";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

describe("OverflowMenu", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  it("renders a trigger with menu a11y attributes, collapsed by default", () => {
    render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);

    const trigger = screen.getByRole("button", { name: "更多選項" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu and shows items as menuitems with correct labels", () => {
    render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多選項" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "隱藏書籍" })).toBeInTheDocument();
  });

  it("renders all items (extensible to multiple options)", () => {
    render(
      <OverflowMenu
        items={[
          { label: "隱藏書籍", onSelect: () => {} },
          { label: "加入最愛", onSelect: () => {} },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));

    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "隱藏書籍" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "加入最愛" })).toBeInTheDocument();
  });

  it("calls the item's onSelect and closes the menu when an item is clicked", () => {
    const onSelect = vi.fn();
    render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect }]} />);

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "隱藏書籍" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多選項" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("closes the menu on Escape", () => {
    render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the menu on outside click", () => {
    render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the menu open when clicking inside the portaled menu", () => {
    render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    // A mousedown landing on the menu container itself must NOT close it
    // (validates isInsideMenu's check against the portaled menu ref).
    fireEvent.mouseDown(menu);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("keeps the menu open when clicking the trigger button (toggle, not outside)", () => {
    render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);

    const trigger = screen.getByRole("button", { name: "更多選項" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // mousedown on the trigger is inside-menu → outside-click handler ignores it.
    fireEvent.mouseDown(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("with no provider, portals the menu into the default container (document.body), outside the trigger's subtree", () => {
    const { container } = render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));

    const menu = screen.getByRole("menu");
    // The menu must NOT live inside the component's own rendered subtree...
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // ...but it must exist somewhere under document.body (the portal target).
    expect(document.body.contains(menu)).toBe(true);
  });

  it("notifies onOpenChange when opening and closing", () => {
    const onOpenChange = vi.fn();
    render(
      <OverflowMenu
        items={[{ label: "隱藏書籍", onSelect: () => {} }]}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("removes document listeners on unmount (no error on later events)", () => {
    const { unmount } = render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    unmount();

    // Dispatching after unmount must not throw or re-open anything.
    expect(() => {
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.mouseDown(document.body);
    }).not.toThrow();
  });

  describe("portal container targeting (Shadow DOM support)", () => {
    let customContainer: HTMLElement;

    beforeEach(() => {
      customContainer = document.createElement("div");
      customContainer.id = "custom-portal-target";
      document.body.appendChild(customContainer);
    });

    afterEach(() => {
      customContainer.remove();
    });

    it("renders the opened menu inside the container from PortalContainerContext", () => {
      render(
        <PortalContainerContext.Provider value={customContainer}>
          <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />
        </PortalContainerContext.Provider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));

      const menu = screen.getByRole("menu");
      expect(customContainer.contains(menu)).toBe(true);
    });

    it("falls back to document.body when no provider is present", () => {
      render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);

      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));

      const menu = screen.getByRole("menu");
      // Default context value is document.body, and NOT the custom container.
      expect(document.body.contains(menu)).toBe(true);
      expect(customContainer.contains(menu)).toBe(false);
    });
  });

  // Regression coverage for the Shadow DOM outside-click bug: when the menu is
  // portaled into an OPEN shadow root, a `mousedown` on a menu item is retargeted
  // to the shadow host at the document level. A `contains(event.target)` check
  // therefore treats the click as "outside" and closes the menu before the item's
  // onClick fires. useDismissableMenu must use `event.composedPath()` (which
  // pierces the shadow boundary) so inside-menu clicks are recognised. A plain
  // light-DOM portal container (the block above) cannot reproduce retargeting.
  describe("portaled into a real open shadow root (retargeting)", () => {
    let host: HTMLDivElement;
    let shadowRoot: ShadowRoot;
    let reactContainer: HTMLDivElement;

    beforeEach(() => {
      host = document.createElement("div");
      document.body.appendChild(host);
      shadowRoot = host.attachShadow({ mode: "open" });
      // Mirror production: the dialog (and thus the trigger) is mounted INTO the
      // shadow tree, and the ShadowRoot itself is the portal container.
      reactContainer = document.createElement("div");
      shadowRoot.appendChild(reactContainer);
    });

    afterEach(() => {
      host.remove();
    });

    const renderInShadow = (items: OverflowMenuItem[]) =>
      render(
        <PortalContainerContext.Provider value={shadowRoot}>
          <OverflowMenu items={items} />
        </PortalContainerContext.Provider>,
        { container: reactContainer },
      );

    // `screen` queries the light DOM and will not pierce the shadow boundary, so
    // resolve the trigger/menu/items directly from the shadow root instead.
    const triggerInShadow = (): HTMLButtonElement => {
      const trigger = shadowRoot.querySelector<HTMLButtonElement>(
        'button[aria-label="更多選項"]',
      );
      if (!trigger) throw new Error("trigger not found in shadow root");
      return trigger;
    };
    const menuInShadow = (): HTMLElement | null =>
      shadowRoot.querySelector<HTMLElement>('[role="menu"]');

    it("renders the opened menu inside the shadow root, not the light DOM", () => {
      renderInShadow([{ label: "隱藏書籍", onSelect: () => {} }]);

      fireEvent.click(triggerInShadow());

      const menu = menuInShadow();
      expect(menu).not.toBeNull();
      expect(shadowRoot.contains(menu)).toBe(true);
      // The panel must NOT have escaped into the page's light DOM.
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });

    it("keeps the menu open and fires onSelect when a menu item is clicked inside the shadow root", () => {
      const onSelect = vi.fn();
      renderInShadow([{ label: "隱藏書籍", onSelect }]);

      fireEvent.click(triggerInShadow());
      const item = shadowRoot.querySelector<HTMLButtonElement>('[role="menuitem"]');
      if (!item) throw new Error("menuitem not found in shadow root");

      // Full pointer sequence on the item. The mousedown is retargeted to the
      // host at document level; the dismiss handler must recognise it as
      // inside-menu (via composedPath) and NOT close the menu before the click.
      fireEvent.mouseDown(item);
      fireEvent.mouseUp(item);
      fireEvent.click(item);

      // If the retargeting bug is present, mousedown closes the menu first and
      // the item's onClick never runs, so onSelect is never called.
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("closes the menu on a genuine outside click even in the shadow setup", () => {
      renderInShadow([{ label: "隱藏書籍", onSelect: () => {} }]);

      fireEvent.click(triggerInShadow());
      expect(menuInShadow()).not.toBeNull();

      // A click in the page's light DOM is truly outside the shadow-rooted menu.
      fireEvent.mouseDown(document.body);

      expect(menuInShadow()).toBeNull();
    });
  });

  describe("responsive sizing", () => {
    // The 28px (desktop) / 32px (mobile) trigger sizing moved from inline styles
    // to `.moo-overflow__trigger` + the `--mobile` modifier in styles.css. jsdom
    // does not apply stylesheet rules, so the observable contract is the modifier
    // class presence/absence.
    it("renders a desktop trigger without the --mobile modifier", () => {
      vi.mocked(useIsMobile).mockReturnValue(false);
      render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);
      const trigger = screen.getByRole("button", { name: "更多選項" });
      expect(trigger).toHaveClass("moo-overflow__trigger");
      expect(trigger).not.toHaveClass("moo-overflow__trigger--mobile");
    });

    it("adds the --mobile modifier on the trigger on mobile", () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />);
      const trigger = screen.getByRole("button", { name: "更多選項" });
      expect(trigger).toHaveClass("moo-overflow__trigger");
      expect(trigger).toHaveClass("moo-overflow__trigger--mobile");
    });
  });
});
