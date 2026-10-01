import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import React from "react";
import { BookSortDropdown } from "@/components/BookSortDropdown";
import type { BookSortMode } from "moo-family-bookshelf-shared/familyShelf/sortBooks";

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
    expect(screen.getByLabelText("排序方式")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it.each<{ value: BookSortMode; label: string }>([
    { value: "default", label: "預設順序" },
    { value: "title-asc", label: "書名 A → Z" },
    { value: "title-desc", label: "書名 Z → A" },
    { value: "author-asc", label: "作者 A → Z" },
    { value: "author-desc", label: "作者 Z → A" },
  ])(
    "marks option '$label' as selected when value is '$value'",
    ({ value, label }) => {
      render(<BookSortDropdown value={value} onChange={vi.fn()} />);

      const listbox = openListbox();
      const selected = within(listbox).getByRole("option", { name: label });
      expect(selected).toHaveAttribute("aria-selected", "true");
    },
  );

  it.each<{ label: string; expected: BookSortMode }>([
    { label: "預設順序", expected: "default" },
    { label: "書名 A → Z", expected: "title-asc" },
    { label: "書名 Z → A", expected: "title-desc" },
    { label: "作者 A → Z", expected: "author-asc" },
    { label: "作者 Z → A", expected: "author-desc" },
  ])(
    "calls onChange('$expected') and closes when selecting $label",
    ({ label, expected }) => {
      const onChange = vi.fn();
      render(<BookSortDropdown value="default" onChange={onChange} />);

      const listbox = openListbox();
      fireEvent.click(within(listbox).getByRole("option", { name: label }));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(expected);
      // Popover closes after selection.
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    },
  );

  it("applies active styling when value is not 'default'", () => {
    const { rerender } = render(
      <BookSortDropdown value="default" onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText("排序方式").className).not.toContain(
      "border-blue-500",
    );

    rerender(<BookSortDropdown value="title-asc" onChange={vi.fn()} />);
    expect(screen.getByLabelText("排序方式").className).toContain(
      "border-blue-500",
    );
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

  it("closes the popover on Escape", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    openListbox();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("排序方式")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  // Inline popover: it scrolls along with its trigger, and mobile address-bar
  // collapse fires resize, so neither may dismiss it.
  it("stays open on page scroll and window resize", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    openListbox();
    fireEvent.scroll(window);
    fireEvent.scroll(document);
    fireEvent(window, new Event("resize"));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Positive companion: the dismissal listeners are live — Escape still works.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes when the trigger is pressed again (mousedown on the trigger is not an outside click)", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    openListbox();
    const trigger = screen.getByLabelText("排序方式");
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selects an option on a real mousedown + click sequence", () => {
    const onChange = vi.fn();
    render(<BookSortDropdown value="default" onChange={onChange} />);

    const listbox = openListbox();
    const option = within(listbox).getByRole("option", { name: "書名 A → Z" });
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith("title-asc");
  });

  // Focus starts on an option — where a keyboard user is while the menu is
  // open — so a focus that is NOT moved falls to <body> when that option
  // unmounts with the menu.
  describe("focus after closing", () => {
    function renderWithOutside(onChange: (mode: BookSortMode) => void) {
      render(
        <div>
          <button>outside</button>
          <BookSortDropdown value="default" onChange={onChange} />
        </div>,
      );
    }

    function openAndFocusOption(label: string): HTMLElement {
      const option = within(openListbox()).getByRole("option", {
        name: label,
      });
      option.focus();
      expect(option).toHaveFocus();
      return option;
    }

    it.each<{ label: string; expected: BookSortMode }>([
      { label: "預設順序", expected: "default" },
      { label: "作者 Z → A", expected: "author-desc" },
    ])(
      "returns focus to the trigger after choosing $label",
      ({ label, expected }) => {
        const onChange = vi.fn();
        renderWithOutside(onChange);
        const option = openAndFocusOption(label);

        fireEvent.click(option);

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(expected);
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(screen.getByLabelText("排序方式")).toHaveFocus();
      },
    );

    it("returns focus to the trigger when Escape closes the menu", () => {
      const onChange = vi.fn();
      renderWithOutside(onChange);
      const option = openAndFocusOption("書名 A → Z");

      fireEvent.keyDown(option, { key: "Escape" });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.getByLabelText("排序方式")).toHaveFocus();
      expect(onChange).not.toHaveBeenCalled();
    });

    // Negative companion: the user went elsewhere, so focus is not pulled back.
    it("does not move focus to the trigger on an outside mousedown", () => {
      renderWithOutside(vi.fn());
      openAndFocusOption("書名 A → Z");

      fireEvent.mouseDown(screen.getByText("outside"));

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.getByLabelText("排序方式")).not.toHaveFocus();
    });
  });
});
