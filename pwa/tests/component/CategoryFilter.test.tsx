import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import { CategoryFilter } from "@/components/CategoryFilter";

afterEach(cleanup);

// Three categories: 小說 ×2, 漫畫 ×1, and one uncategorized book (未分類).
const BOOKS = [
  { category: "小說" },
  { category: "小說" },
  { category: "漫畫" },
  { category: "" },
];

function renderFilter({
  books = BOOKS,
  value = "",
  onChange = vi.fn(),
}: {
  books?: { category: string }[];
  value?: string;
  onChange?: (value: string) => void;
} = {}) {
  return render(
    <div>
      <button>outside</button>
      <CategoryFilter books={books} value={value} onChange={onChange} />
    </div>,
  );
}

function trigger(): HTMLElement {
  return screen.getByLabelText("篩選分類");
}

/** Opens the popover by clicking the trigger and returns its listbox. */
function openListbox(): HTMLElement {
  fireEvent.click(trigger());
  return screen.getByRole("listbox", { name: "分類選單" });
}

function optionByLabel(listbox: HTMLElement, label: string): HTMLElement {
  const option = within(listbox)
    .getAllByRole("option")
    .find((o) => o.firstElementChild?.textContent === label);
  if (!option) throw new Error(`option not found: ${label}`);
  return option;
}

describe("CategoryFilter", () => {
  it.each<{ name: string; books: { category: string }[] }>([
    { name: "no books", books: [] },
    {
      name: "a single category",
      books: [{ category: "小說" }, { category: "小說" }],
    },
    { name: "only uncategorized books", books: [{ category: "" }] },
  ])("renders nothing when there is $name", ({ books }) => {
    const { container } = render(
      <CategoryFilter books={books} value="" onChange={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders a collapsed trigger when there are two or more categories", () => {
    renderFilter();

    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens a listbox with 全部分類 first, the categories, and 未分類 last with counts", () => {
    renderFilter();

    const listbox = openListbox();
    const options = within(listbox).getAllByRole("option");

    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(options).toHaveLength(4);
    expect(options[0]).toHaveTextContent("全部分類");
    expect(options[0]).toHaveTextContent("4");
    expect(options[3]).toHaveTextContent("未分類");
    expect(options[3]).toHaveTextContent("1");
    expect(optionByLabel(listbox, "小說")).toHaveTextContent("2");
    expect(optionByLabel(listbox, "漫畫")).toHaveTextContent("1");
  });

  it.each<{ label: string; expected: string }>([
    { label: "全部分類", expected: "" },
    { label: "小說", expected: "小說" },
    { label: "未分類", expected: "未分類" },
  ])(
    "calls onChange('$expected') and closes when $label is clicked",
    ({ label, expected }) => {
      const onChange = vi.fn();
      renderFilter({ value: "漫畫", onChange });

      const listbox = openListbox();
      fireEvent.click(optionByLabel(listbox, label));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(expected);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    },
  );

  it("selects an option on a real mousedown + click sequence", () => {
    const onChange = vi.fn();
    renderFilter({ onChange });

    const option = optionByLabel(openListbox(), "漫畫");
    // The mousedown lands inside the menu, so it must not close the popover
    // before the click reaches the option.
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith("漫畫");
  });

  it("closes the popover on an outside mousedown", () => {
    renderFilter();

    openListbox();
    fireEvent.mouseDown(screen.getByText("outside"));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the popover on Escape", () => {
    renderFilter();

    openListbox();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open on a non-Escape key", () => {
    renderFilter();

    openListbox();
    fireEvent.keyDown(document, { key: "Enter" });

    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  // Inline popover: it scrolls along with its trigger, and mobile address-bar
  // collapse fires resize, so neither may dismiss it.
  it("stays open on page scroll and window resize", () => {
    renderFilter();

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
    renderFilter();

    openListbox();
    fireEvent.mouseDown(trigger());
    fireEvent.click(trigger());

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes the popover when the value is cleared externally", () => {
    const { rerender } = renderFilter({ value: "小說" });

    openListbox();
    rerender(
      <div>
        <button>outside</button>
        <CategoryFilter books={BOOKS} value="" onChange={vi.fn()} />
      </div>,
    );

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
