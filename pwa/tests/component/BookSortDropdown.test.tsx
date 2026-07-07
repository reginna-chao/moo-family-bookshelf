import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import React from "react";
import { BookSortDropdown } from "@/components/BookSortDropdown";
import type { BookSortMode } from "@/utils/sortBooks";

afterEach(cleanup);

/** Opens the popover by clicking the trigger and returns its listbox. */
function openListbox(): HTMLElement {
  fireEvent.click(screen.getByLabelText("書籍排序"));
  return screen.getByRole("listbox", { name: "書籍排序選單" });
}

describe("BookSortDropdown", () => {
  it("renders the trigger button with an aria-label and starts closed", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const trigger = screen.getByLabelText("書籍排序");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens the listbox with three options when the trigger is clicked", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const listbox = openListbox();
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent("預設順序");
    expect(options[1]).toHaveTextContent("依書名排序");
    expect(options[2]).toHaveTextContent("依作者排序");
    expect(screen.getByLabelText("書籍排序")).toHaveAttribute("aria-expanded", "true");
  });

  it("marks the option matching value as selected", () => {
    render(<BookSortDropdown value="author" onChange={vi.fn()} />);

    const listbox = openListbox();
    const selected = within(listbox).getByRole("option", { name: "依作者排序" });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });

  it.each<{ label: string; expected: BookSortMode }>([
    { label: "預設順序", expected: "default" },
    { label: "依書名排序", expected: "title" },
    { label: "依作者排序", expected: "author" },
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
    expect(screen.getByLabelText("書籍排序").className).not.toContain("border-blue-500");

    rerender(<BookSortDropdown value="title" onChange={vi.fn()} />);
    expect(screen.getByLabelText("書籍排序").className).toContain("border-blue-500");
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
