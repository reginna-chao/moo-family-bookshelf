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
});
