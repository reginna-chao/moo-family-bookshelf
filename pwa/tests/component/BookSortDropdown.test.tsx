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

const OPTIONS: Array<{ value: BookSortMode; label: string }> = [
  { value: "default", label: "預設順序" },
  { value: "title-asc", label: "書名 A → Z" },
  { value: "title-desc", label: "書名 Z → A" },
  { value: "author-asc", label: "作者 A → Z" },
  { value: "author-desc", label: "作者 Z → A" },
];

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

  // Focus starts on an option — where a keyboard user is while the menu is open — so a focus
  // that is NOT moved falls to <body> when that option unmounts with the menu.
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

  it("marks the trigger as a non-submitting button that opens a listbox", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "排序方式" });
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  });

  it("renders every option as a non-submitting button", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const options = within(openListbox()).getAllByRole("option");
    expect(options).toHaveLength(OPTIONS.length);
    for (const option of options) {
      expect(option).toHaveAttribute("type", "button");
    }
  });

  // Listbox keyboard model, matching extension/tests/component/BookSortDropdown.test.tsx: focus
  // stays on the listbox and aria-activedescendant names the option the arrow keys point at.
  describe("keyboard navigation", () => {
    function openMenu(value: BookSortMode = "default", onChange = vi.fn()) {
      render(<BookSortDropdown value={value} onChange={onChange} />);
      const trigger = screen.getByRole("button", { name: "排序方式" });
      fireEvent.click(trigger);
      return { trigger, listbox: screen.getByRole("listbox"), onChange };
    }

    /** The id of the option currently pointed at by aria-activedescendant. */
    function activeOptionId(listbox: HTMLElement): string | null {
      return listbox.getAttribute("aria-activedescendant");
    }

    /** The DOM id of a given option, looked up by its visible label. */
    function optionId(label: string): string {
      const { id } = screen.getByRole("option", { name: label });
      expect(id).not.toBe("");
      return id;
    }

    it("focuses the listbox on open so the arrow keys reach it", () => {
      const { listbox } = openMenu();

      expect(listbox).toHaveFocus();
      expect(listbox).toHaveAttribute("tabindex", "-1");
      expect(listbox).toHaveAttribute("aria-label", "排序方式選單");
    });

    it.each(OPTIONS)(
      "seeds aria-activedescendant from value '$value' on open",
      ({ value, label }) => {
        const { listbox } = openMenu(value);

        expect(activeOptionId(listbox)).toBe(optionId(label));
      },
    );

    it("moves the active descendant down through every option with ArrowDown", () => {
      const { listbox } = openMenu("default");

      for (const { label } of OPTIONS.slice(1)) {
        fireEvent.keyDown(listbox, { key: "ArrowDown" });
        expect(activeOptionId(listbox)).toBe(optionId(label));
      }
    });

    it("moves the active descendant up through every option with ArrowUp", () => {
      const { listbox } = openMenu("author-desc");

      for (const { label } of [...OPTIONS].reverse().slice(1)) {
        fireEvent.keyDown(listbox, { key: "ArrowUp" });
        expect(activeOptionId(listbox)).toBe(optionId(label));
      }
    });

    it.each<{ name: string; value: BookSortMode; key: string; label: string }>([
      {
        name: "ArrowUp at the top",
        value: "default",
        key: "ArrowUp",
        label: "預設順序",
      },
      {
        name: "ArrowDown at the bottom",
        value: "author-desc",
        key: "ArrowDown",
        label: "作者 Z → A",
      },
    ])("stays put on $name (no wrap)", ({ value, key, label }) => {
      const { listbox } = openMenu(value);

      fireEvent.keyDown(listbox, { key });

      expect(activeOptionId(listbox)).toBe(optionId(label));
    });

    it.each<{ key: string; from: BookSortMode; label: string }>([
      { key: "Home", from: "author-desc", label: "預設順序" },
      { key: "End", from: "default", label: "作者 Z → A" },
    ])("jumps to $label on $key", ({ key, from, label }) => {
      const { listbox } = openMenu(from);

      fireEvent.keyDown(listbox, { key });

      expect(activeOptionId(listbox)).toBe(optionId(label));
    });

    it.each(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "])(
      "prevents the browser default for key '%s'",
      (key) => {
        const { listbox } = openMenu("title-desc");

        // fireEvent returns false when the handler called preventDefault().
        expect(fireEvent.keyDown(listbox, { key })).toBe(false);
      },
    );

    it.each<{
      name: string;
      moves: string[];
      commit: string;
      expected: BookSortMode;
    }>([
      {
        name: "Enter",
        moves: ["ArrowDown"],
        commit: "Enter",
        expected: "title-asc",
      },
      { name: "Space", moves: ["End"], commit: " ", expected: "author-desc" },
    ])(
      "selects the active option with $name, closes and refocuses the trigger",
      ({ moves, commit, expected }) => {
        const onChange = vi.fn();
        const { trigger, listbox } = openMenu("default", onChange);

        for (const key of moves) fireEvent.keyDown(listbox, { key });
        fireEvent.keyDown(listbox, { key: commit });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(expected);
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
      },
    );

    it("re-seeds the active option from value when reopened after arrow moves", () => {
      const { trigger, listbox } = openMenu("title-asc");
      fireEvent.keyDown(listbox, { key: "End" });
      fireEvent.keyDown(document, { key: "Escape" });

      fireEvent.click(trigger);

      const reopened = screen.getByRole("listbox");
      expect(activeOptionId(reopened)).toBe(optionId("書名 A → Z"));
    });

    // Selected stays blue; only a keyboard-active option that is NOT selected turns grey.
    it("greys out the keyboard-active option only while it is not the selected one", () => {
      const { listbox } = openMenu("default");
      const selected = screen.getByRole("option", { name: "預設順序" });
      const next = screen.getByRole("option", { name: "書名 A → Z" });
      expect(selected).toHaveClass("bg-blue-50");
      expect(selected).not.toHaveClass("bg-gray-100");
      expect(next).not.toHaveClass("bg-gray-100");

      fireEvent.keyDown(listbox, { key: "ArrowDown" });

      expect(next).toHaveClass("bg-gray-100");
      expect(selected).toHaveClass("bg-blue-50");
      const greyed = within(listbox)
        .getAllByRole("option")
        .filter((o) => o.classList.contains("bg-gray-100"));
      expect(greyed).toEqual([next]);
    });

    it("keeps every option out of the Tab order", () => {
      const { listbox } = openMenu("default");

      const options = within(listbox).getAllByRole("option");
      expect(options).toHaveLength(OPTIONS.length);
      for (const option of options) {
        expect(option).toHaveAttribute("tabindex", "-1");
      }
    });

    // PWA-only rule (the Extension refocuses the trigger): Tab leaves focus to the browser.
    it.each([
      { name: "Tab", shiftKey: false },
      { name: "Shift+Tab", shiftKey: true },
    ])(
      "closes without selecting and keeps the native focus move on $name",
      ({ shiftKey }) => {
        const onChange = vi.fn();
        const { trigger, listbox } = openMenu("default", onChange);
        fireEvent.keyDown(listbox, { key: "ArrowDown" });

        // fireEvent returns true when the handler did NOT call preventDefault().
        expect(fireEvent.keyDown(listbox, { key: "Tab", shiftKey })).toBe(true);

        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(document.activeElement).not.toBe(trigger);
      },
    );
  });
});
