import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { OverflowMenu } from "@/dialog/OverflowMenu";

describe("OverflowMenu", () => {
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
});
