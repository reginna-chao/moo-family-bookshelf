import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { BookSortDropdown } from "@/dialog/BookSortDropdown";
import type { BookSortMode } from "@/dialog/sortBooks";

/**
 * BookSortDropdown is now a custom listbox dropdown (no native <select>):
 *  - trigger <button aria-label="排序方式" aria-haspopup="listbox" aria-expanded>
 *  - opens a portaled <div role="listbox"> with 3 <button role="option">.
 * The menu is portaled to document.body, but it lives in the same jsdom
 * document, so screen queries still find it. Use queryByRole("option") to
 * assert presence/absence.
 */

const OPTION_LABELS = ["預設順序", "依書名排序", "依作者排序"];

describe("BookSortDropdown", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the trigger button with listbox aria attributes, closed by default", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "排序方式" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not render any option until the menu is opened", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    for (const label of OPTION_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("opens the menu and shows all three options when the trigger is clicked", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "排序方式" });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.textContent)).toEqual(OPTION_LABELS);
  });

  it("marks only the option matching the value prop as aria-selected", () => {
    render(<BookSortDropdown value="title" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "排序方式" }));

    const selected = screen.getByRole("option", { name: "依書名排序" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "預設順序" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("option", { name: "依作者排序" })).toHaveAttribute("aria-selected", "false");
  });

  it.each<{ label: string; expected: BookSortMode }>([
    { label: "預設順序", expected: "default" },
    { label: "依書名排序", expected: "title" },
    { label: "依作者排序", expected: "author" },
  ])("calls onChange('$expected') and closes when selecting $label", ({ label, expected }) => {
    const onChange = vi.fn();
    render(<BookSortDropdown value="default" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "排序方式" }));
    fireEvent.click(screen.getByRole("option", { name: label }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expected);
    // Menu closes after selection.
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("closes the menu on an outside mousedown", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "排序方式" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("closes the menu when Escape is pressed", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "排序方式" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  describe("keyboard navigation", () => {
    /** Open the menu and return both the trigger and the portaled listbox. */
    function openMenu(value: BookSortMode = "default", onChange = vi.fn()) {
      render(<BookSortDropdown value={value} onChange={onChange} />);
      const trigger = screen.getByRole("button", { name: "排序方式" });
      fireEvent.click(trigger);
      const listbox = screen.getByRole("listbox");
      return { trigger, listbox, onChange };
    }

    /** The id of the option currently pointed at by aria-activedescendant. */
    function activeOptionId(listbox: HTMLElement): string | null {
      return listbox.getAttribute("aria-activedescendant");
    }

    /** The DOM id of a given option, looked up by its visible label. */
    function optionId(label: string): string {
      return screen.getByRole("option", { name: label }).id;
    }

    it("exposes the listbox with an accessible label", () => {
      const { listbox } = openMenu();
      expect(listbox).toHaveAttribute("aria-label", "排序方式選單");
      expect(listbox).toHaveAttribute("tabindex", "-1");
    });

    it("seeds aria-activedescendant from the current value on open", () => {
      const { listbox } = openMenu("title");
      expect(activeOptionId(listbox)).toBe(optionId("依書名排序"));
    });

    it("defaults the active descendant to the first option when value is default", () => {
      const { listbox } = openMenu("default");
      expect(activeOptionId(listbox)).toBe(optionId("預設順序"));
    });

    it("moves the active descendant down with ArrowDown", () => {
      const { listbox } = openMenu("default");
      expect(activeOptionId(listbox)).toBe(optionId("預設順序"));

      fireEvent.keyDown(listbox, { key: "ArrowDown" });
      expect(activeOptionId(listbox)).toBe(optionId("依書名排序"));

      fireEvent.keyDown(listbox, { key: "ArrowDown" });
      expect(activeOptionId(listbox)).toBe(optionId("依作者排序"));
    });

    it("moves the active descendant up with ArrowUp", () => {
      const { listbox } = openMenu("author");
      expect(activeOptionId(listbox)).toBe(optionId("依作者排序"));

      fireEvent.keyDown(listbox, { key: "ArrowUp" });
      expect(activeOptionId(listbox)).toBe(optionId("依書名排序"));

      fireEvent.keyDown(listbox, { key: "ArrowUp" });
      expect(activeOptionId(listbox)).toBe(optionId("預設順序"));
    });

    it("stops at the first option when ArrowUp is pressed at the top (no wrap)", () => {
      const { listbox } = openMenu("default");
      expect(activeOptionId(listbox)).toBe(optionId("預設順序"));

      fireEvent.keyDown(listbox, { key: "ArrowUp" });

      expect(activeOptionId(listbox)).toBe(optionId("預設順序"));
    });

    it("stops at the last option when ArrowDown is pressed at the bottom (no wrap)", () => {
      const { listbox } = openMenu("author");
      expect(activeOptionId(listbox)).toBe(optionId("依作者排序"));

      fireEvent.keyDown(listbox, { key: "ArrowDown" });

      expect(activeOptionId(listbox)).toBe(optionId("依作者排序"));
    });

    it("jumps to the first option on Home", () => {
      const { listbox } = openMenu("author");
      expect(activeOptionId(listbox)).toBe(optionId("依作者排序"));

      fireEvent.keyDown(listbox, { key: "Home" });

      expect(activeOptionId(listbox)).toBe(optionId("預設順序"));
    });

    it("jumps to the last option on End", () => {
      const { listbox } = openMenu("default");
      expect(activeOptionId(listbox)).toBe(optionId("預設順序"));

      fireEvent.keyDown(listbox, { key: "End" });

      expect(activeOptionId(listbox)).toBe(optionId("依作者排序"));
    });

    it("selects the active option with Enter, closes, restores focus, and reports the value", () => {
      const onChange = vi.fn();
      const { trigger, listbox } = openMenu("default", onChange);

      // Move active to the second option, then commit with Enter.
      fireEvent.keyDown(listbox, { key: "ArrowDown" });
      fireEvent.keyDown(listbox, { key: "Enter" });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith("title");
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });

    it("selects the active option with Space, closes, restores focus, and reports the value", () => {
      const onChange = vi.fn();
      const { trigger, listbox } = openMenu("default", onChange);

      // Move active to the third option, then commit with Space.
      fireEvent.keyDown(listbox, { key: "End" });
      fireEvent.keyDown(listbox, { key: " " });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith("author");
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });

    it("returns focus to the trigger when closed via Escape", () => {
      const { trigger } = openMenu("default");

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
