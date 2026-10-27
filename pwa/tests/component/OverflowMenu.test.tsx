import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu";

/** Three labelled options, enough to observe wrap-around in both directions. */
const THREE_ITEMS: OverflowMenuItem[] = [
  { label: "隱藏書籍", onSelect: () => {} },
  { label: "加入最愛", onSelect: () => {} },
  { label: "回報問題", onSelect: () => {} },
];

/** The element that currently holds focus. */
function focusedElement(): HTMLElement {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) throw new Error("nothing is focused");
  return el;
}

describe("OverflowMenu", () => {
  it("renders a trigger with menu a11y attributes, collapsed by default", () => {
    render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    const trigger = screen.getByRole("button", { name: "更多選項" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu and shows items as menuitems with correct labels", () => {
    render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多選項" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByRole("menuitem", { name: "隱藏書籍" }),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("menuitem", { name: "隱藏書籍" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "加入最愛" }),
    ).toBeInTheDocument();
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
    render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the menu on outside click", () => {
    render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the menu open when clicking inside the portaled menu", () => {
    render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();

    // A mousedown landing on the menu container itself must NOT close it
    // (validates isInsideMenu's check against the portaled menu ref).
    fireEvent.mouseDown(menu);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("keeps the menu open when clicking the trigger button (toggle, not outside)", () => {
    render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    const trigger = screen.getByRole("button", { name: "更多選項" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // mousedown on the trigger is inside-menu → outside-click handler ignores it.
    fireEvent.mouseDown(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("portals the menu to document.body, not inside the trigger wrapper", () => {
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

  // The panel is portaled and `position: fixed`, so unlike the inline dropdowns it detaches from its
  // trigger when the page moves — scroll and resize close it; every dismissal reports onOpenChange(false).
  it.each<{ name: string; fire: () => void }>([
    {
      name: "outside mousedown",
      fire: () => fireEvent.mouseDown(document.body),
    },
    {
      name: "Escape",
      fire: () => fireEvent.keyDown(document, { key: "Escape" }),
    },
    { name: "window scroll", fire: () => fireEvent.scroll(window) },
    { name: "document scroll", fire: () => fireEvent.scroll(document) },
    {
      name: "window resize",
      fire: () => fireEvent(window, new Event("resize")),
    },
  ])("closes on $name and notifies onOpenChange(false)", ({ fire }) => {
    const onOpenChange = vi.fn();
    render(
      <OverflowMenu
        items={[{ label: "隱藏書籍", onSelect: () => {} }]}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    onOpenChange.mockClear();

    fire();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "更多選項" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it.each<{ name: string; target: () => HTMLElement; bubbles: boolean }>([
    {
      name: "on the menu panel",
      target: () => screen.getByRole("menu"),
      bubbles: false,
    },
    {
      name: "bubbling up from a menu item",
      target: () => screen.getByRole("menuitem", { name: "隱藏書籍" }),
      bubbles: true,
    },
  ])("stays open on a scroll starting $name", ({ target, bubbles }) => {
    const onOpenChange = vi.fn();
    render(
      <OverflowMenu
        items={[{ label: "隱藏書籍", onSelect: () => {} }]}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    onOpenChange.mockClear();

    fireEvent(target(), new Event("scroll", { bubbles }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  // Focus starts on a menu item — where a keyboard user is while the menu is open — so a focus
  // that is NOT moved falls to <body> when the portaled panel unmounts.
  describe("focus after closing", () => {
    function openAndFocusItem(): HTMLElement {
      render(
        <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
      const item = screen.getByRole("menuitem", { name: "隱藏書籍" });
      item.focus();
      expect(item).toHaveFocus();
      return item;
    }

    it("returns focus to the trigger when Escape closes the menu", () => {
      const item = openAndFocusItem();

      fireEvent.keyDown(item, { key: "Escape" });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "更多選項" })).toHaveFocus();
    });

    // A real pointer click carries detail >= 1: focus follows the mouse and is
    // not pulled back to the trigger.
    it("does not move focus to the trigger when an item is clicked with the mouse", () => {
      const item = openAndFocusItem();

      fireEvent.click(item, { detail: 1 });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "更多選項" }),
      ).not.toHaveFocus();
    });

    // Enter / Space on a button fire a click with detail === 0. The trigger must hold focus BEFORE
    // onSelect runs, since a destructive option can unmount the row (and strand focus on <body>).
    it("refocuses the trigger before onSelect when an item is activated by keyboard", () => {
      let focusedDuringSelect: Element | null = null;
      const onSelect = vi.fn(() => {
        focusedDuringSelect = document.activeElement;
      });
      render(<OverflowMenu items={[{ label: "隱藏書籍", onSelect }]} />);
      const trigger = screen.getByRole("button", { name: "更多選項" });
      fireEvent.click(trigger);

      fireEvent.click(screen.getByRole("menuitem", { name: "隱藏書籍" }), {
        detail: 0,
      });

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(focusedDuringSelect).toBe(trigger);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    // The user moved to another control while the menu stayed open: closing must not steal it back.
    it("leaves focus alone on an outside mousedown when focus is not in the panel", () => {
      render(
        <div>
          <button type="button">outside</button>
          <OverflowMenu items={THREE_ITEMS} />
        </div>,
      );
      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
      const outside = screen.getByRole("button", { name: "outside" });
      outside.focus();

      fireEvent.mouseDown(outside);

      // Positive companion: the mousedown did dismiss the menu.
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(outside).toHaveFocus();
      expect(
        screen.getByRole("button", { name: "更多選項" }),
      ).not.toHaveFocus();
    });
  });

  // The panel is portaled to the end of the DOM, so native Tab never reaches it: the component moves
  // focus in once positioned, cycles on Arrow / Tab, and returns it to the trigger on Escape.
  describe("keyboard focus management", () => {
    /** Opens the menu and returns the trigger plus the rendered menu items. */
    function openMenu(items: OverflowMenuItem[] = THREE_ITEMS) {
      render(<OverflowMenu items={items} />);
      const trigger = screen.getByRole("button", { name: "更多選項" });
      fireEvent.click(trigger);
      return { trigger, menuItems: screen.getAllByRole("menuitem") };
    }

    it("moves focus to the first menu item when the menu opens", () => {
      const { menuItems } = openMenu();

      expect(menuItems[0]).toHaveFocus();
    });

    it.each([
      {
        name: "ArrowDown moves focus to the next item",
        keys: [{ key: "ArrowDown" }],
        expectedIndex: 1,
      },
      {
        name: "ArrowDown wraps from the last item back to the first",
        keys: [
          { key: "ArrowDown" },
          { key: "ArrowDown" },
          { key: "ArrowDown" },
        ],
        expectedIndex: 0,
      },
      {
        name: "ArrowUp wraps from the first item to the last",
        keys: [{ key: "ArrowUp" }],
        expectedIndex: 2,
      },
      {
        name: "ArrowDown then ArrowUp returns to the first item",
        keys: [{ key: "ArrowDown" }, { key: "ArrowUp" }],
        expectedIndex: 0,
      },
      {
        name: "Tab moves to the next item instead of leaving the menu",
        keys: [{ key: "Tab" }],
        expectedIndex: 1,
      },
      {
        name: "Shift+Tab moves backwards, wrapping to the last item",
        keys: [{ key: "Tab", shiftKey: true }],
        expectedIndex: 2,
      },
    ])("$name", ({ keys, expectedIndex }) => {
      const { menuItems } = openMenu();

      for (const key of keys) {
        fireEvent.keyDown(focusedElement(), key);
      }

      expect(menuItems[expectedIndex]).toHaveFocus();
      // The menu must stay open throughout keyboard navigation.
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it.each([
      { name: "Tab", init: { key: "Tab" } },
      { name: "Shift+Tab", init: { key: "Tab", shiftKey: true } },
      { name: "ArrowDown", init: { key: "ArrowDown" } },
      { name: "ArrowUp", init: { key: "ArrowUp" } },
    ])(
      "prevents the browser default for $name so focus cannot escape the menu",
      ({ init }) => {
        openMenu();

        // fireEvent returns false when the handler called preventDefault().
        expect(fireEvent.keyDown(focusedElement(), init)).toBe(false);
      },
    );

    it("keeps focus on the single item when the menu has only one option", () => {
      const { menuItems } = openMenu([
        { label: "隱藏書籍", onSelect: () => {} },
      ]);

      fireEvent.keyDown(focusedElement(), { key: "ArrowDown" });
      expect(menuItems[0]).toHaveFocus();

      fireEvent.keyDown(focusedElement(), { key: "ArrowUp" });
      expect(menuItems[0]).toHaveFocus();
    });

    it("closes the menu and returns focus to the trigger on Escape", () => {
      const onOpenChange = vi.fn();
      render(<OverflowMenu items={THREE_ITEMS} onOpenChange={onOpenChange} />);
      const trigger = screen.getByRole("button", { name: "更多選項" });
      fireEvent.click(trigger);

      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      // Exactly one close: the document-level dismissal listener never saw the key.
      expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    });

    // An enclosing modal (PublicShareDialog, family-shelf overlays) listens for Escape too; the menu
    // owns it, or one key press would close both layers.
    it("stops Escape on the menu from reaching a document-level keydown listener", () => {
      openMenu();
      const seen: string[] = [];
      const listener = (e: KeyboardEvent) => seen.push(e.key);
      document.addEventListener("keydown", listener);
      try {
        // Positive companion: a key the menu ignores does bubble to the document.
        fireEvent.keyDown(focusedElement(), { key: "a" });
        expect(seen).toEqual(["a"]);

        fireEvent.keyDown(focusedElement(), { key: "Escape" });

        expect(seen).toEqual(["a"]);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      } finally {
        document.removeEventListener("keydown", listener);
      }
    });

    it("re-focuses the first item when the menu is reopened after keyboard navigation", () => {
      const { trigger } = openMenu();

      fireEvent.keyDown(focusedElement(), { key: "ArrowDown" });
      fireEvent.keyDown(focusedElement(), { key: "Escape" });
      fireEvent.click(trigger);

      expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
    });
  });

  it("removes document listeners on unmount (no error on later events)", () => {
    const { unmount } = render(
      <OverflowMenu items={[{ label: "隱藏書籍", onSelect: () => {} }]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
    unmount();

    expect(() => {
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.mouseDown(document.body);
    }).not.toThrow();
  });
});
