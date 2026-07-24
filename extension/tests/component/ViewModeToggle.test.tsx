import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ViewModeToggle } from "@/dialog/ViewModeToggle";
import { useIsMobile } from "@/hooks/useIsMobile";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

describe("ViewModeToggle", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  it("renders both grid and row buttons", () => {
    render(<ViewModeToggle mode="grid" onChange={vi.fn()} />);

    expect(screen.getByLabelText("切換為網格檢視")).toBeInTheDocument();
    expect(screen.getByLabelText("切換為列表檢視")).toBeInTheDocument();
  });

  it("marks grid button as pressed when mode is 'grid'", () => {
    render(<ViewModeToggle mode="grid" onChange={vi.fn()} />);

    expect(screen.getByLabelText("切換為網格檢視")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("切換為列表檢視")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks row button as pressed when mode is 'row'", () => {
    render(<ViewModeToggle mode="row" onChange={vi.fn()} />);

    expect(screen.getByLabelText("切換為網格檢視")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("切換為列表檢視")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("calls onChange('grid') when grid button is clicked", () => {
    const onChange = vi.fn();
    render(<ViewModeToggle mode="row" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("切換為網格檢視"));
    expect(onChange).toHaveBeenCalledWith("grid");
  });

  it("calls onChange('row') when row button is clicked", () => {
    const onChange = vi.fn();
    render(<ViewModeToggle mode="grid" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("切換為列表檢視"));
    expect(onChange).toHaveBeenCalledWith("row");
  });

  it("has a group role with accessible label", () => {
    render(<ViewModeToggle mode="grid" onChange={vi.fn()} />);

    expect(
      screen.getByRole("group", { name: "家庭書櫃顯示模式" }),
    ).toBeInTheDocument();
  });

  describe("responsive sizing", () => {
    // The 40px (desktop) / 32px (mobile) button sizing moved from inline styles
    // to `.moo-view-toggle__btn` + the `--mobile` modifier in styles.css. jsdom
    // does not apply stylesheet rules, so the observable contract is the modifier
    // class presence/absence.
    it("renders desktop buttons without the --mobile modifier", () => {
      vi.mocked(useIsMobile).mockReturnValue(false);
      render(<ViewModeToggle mode="grid" onChange={vi.fn()} />);
      const grid = screen.getByLabelText("切換為網格檢視");
      expect(grid).toHaveClass("moo-view-toggle__btn");
      expect(grid).not.toHaveClass("moo-view-toggle__btn--mobile");
    });

    it("adds the --mobile modifier on the buttons on mobile", () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(<ViewModeToggle mode="grid" onChange={vi.fn()} />);
      const grid = screen.getByLabelText("切換為網格檢視");
      expect(grid).toHaveClass("moo-view-toggle__btn");
      expect(grid).toHaveClass("moo-view-toggle__btn--mobile");
    });
  });

  // Borders / hover fill / focus ring / head-tail radii were folded into the
  // shared `.moo-segmented__item` component class; `.moo-view-toggle__btn` now
  // only pins the 40×40 icon box. jsdom does not apply the stylesheet, so the
  // class list is the contract that keeps the shared base from being dropped.
  describe("shared .moo-segmented__item class contract", () => {
    it.each([
      { label: "切換為網格檢視", position: "first" },
      { label: "切換為列表檢視", position: "last" },
    ])(
      "opts the '$label' button into the shared segmented-item base as --$position",
      ({ label, position }) => {
        render(<ViewModeToggle mode="grid" onChange={vi.fn()} />);

        const button = screen.getByLabelText(label);
        expect(button).toHaveClass("moo-segmented__item");
        expect(button).toHaveClass(`moo-segmented__item--${position}`);
        // The component-specific classes stay alongside (additive refactor).
        expect(button).toHaveClass("moo-view-toggle__btn");
        expect(button).toHaveClass(`moo-view-toggle__btn--${position}`);
      },
    );
  });
});
