import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import React from "react";
import { BookSortDropdown } from "@/components/BookSortDropdown";
import type { BookSortMode } from "@/utils/sortBooks";

afterEach(cleanup);

/** Opens the popover by clicking the trigger and returns its listbox. */
function openListbox(): HTMLElement {
  fireEvent.click(screen.getByLabelText("排序方式"));
  return screen.getByRole("listbox", { name: "排序方式選單" });
}

describe("BookSortDropdown", () => {
  it("renders the trigger button with an aria-label and starts closed", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const trigger = screen.getByLabelText("排序方式");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens the listbox with five 繁中 options when the trigger is clicked", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const listbox = openListbox();
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "預設順序",
      "書名 A → Z",
      "書名 Z → A",
      "作者 A → Z",
      "作者 Z → A",
    ]);
    expect(screen.getByLabelText("排序方式")).toHaveAttribute("aria-expanded", "true");
  });

  it.each<{ value: BookSortMode; label: string }>([
    { value: "default", label: "預設順序" },
    { value: "title-asc", label: "書名 A → Z" },
    { value: "title-desc", label: "書名 Z → A" },
    { value: "author-asc", label: "作者 A → Z" },
    { value: "author-desc", label: "作者 Z → A" },
  ])("marks option '$label' as selected when value is '$value'", ({ value, label }) => {
    render(<BookSortDropdown value={value} onChange={vi.fn()} />);

    const listbox = openListbox();
    const selected = within(listbox).getByRole("option", { name: label });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it.each<{ label: string; expected: BookSortMode }>([
    { label: "預設順序", expected: "default" },
    { label: "書名 A → Z", expected: "title-asc" },
    { label: "書名 Z → A", expected: "title-desc" },
    { label: "作者 A → Z", expected: "author-asc" },
    { label: "作者 Z → A", expected: "author-desc" },
  ])("calls onChange('$expected') and closes when selecting $label", ({ label, expected }) => {
    const onChange = vi.fn();
    render(<BookSortDropdown value="default" onChange={onChange} />);

    const listbox = openListbox();
    fireEvent.click(within(listbox).getByRole("option", { name: label }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expected);
    // Popover closes after selection.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("applies active styling when value is not 'default'", () => {
    const { rerender } = render(<BookSortDropdown value="default" onChange={vi.fn()} />);
    expect(screen.getByLabelText("排序方式").className).not.toContain("border-blue-500");

    rerender(<BookSortDropdown value="title-asc" onChange={vi.fn()} />);
    expect(screen.getByLabelText("排序方式").className).toContain("border-blue-500");
  });

  it("closes the popover on an outside mousedown", () => {
    render(
      <div>
        <button>outside</button>
        <BookSortDropdown value="default" onChange={vi.fn()} />
      </div>,
    );

    openListbox();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
