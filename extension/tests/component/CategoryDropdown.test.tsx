import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { CategoryFilter, filterByCategory } from "@/dialog/CategoryDropdown";
import { useIsMobile } from "@/hooks/useIsMobile";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

function makeBooks(categories: string[]) {
  return categories.map((category, i) => ({ category, bookId: `b${i}` }));
}

describe("CategoryFilter", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    open: false,
    onToggle: vi.fn(),
  };

  it("renders nothing when all books share one category", () => {
    const { container } = render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["奇幻冒險", "奇幻冒險"])}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when book list is empty", () => {
    const { container } = render(
      <CategoryFilter {...defaultProps} books={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders filter icon button with multiple categories", () => {
    render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["奇幻冒險", "韓國耽美", "軍事\\戰略"])}
      />,
    );
    expect(screen.getByLabelText("篩選分類")).toBeInTheDocument();
  });

  it("does not show popover when closed", () => {
    render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["奇幻冒險", "韓國耽美"])}
        open={false}
      />,
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows popover with categories when open", () => {
    render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["奇幻冒險", "韓國耽美"])}
        open={true}
      />,
    );
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    // "全部分類" + 2 categories
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent("全部分類");
  });

  it("shows count per category", () => {
    render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["奇幻冒險", "奇幻冒險", "韓國耽美"])}
        open={true}
      />,
    );
    const options = screen.getAllByRole("option");
    // "全部分類 3", "奇幻冒險 2", "韓國耽美 1"
    expect(options[0]).toHaveTextContent("3");
    expect(options[1]).toHaveTextContent("2");
    expect(options[2]).toHaveTextContent("1");
  });

  it("sorts 未分類 to the end", () => {
    render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["韓國耽美", "", "奇幻冒險"])}
        open={true}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveTextContent("未分類");
  });

  it("calls onChange and onToggle when a category is selected", () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    render(
      <CategoryFilter
        books={makeBooks(["奇幻冒險", "韓國耽美"])}
        value=""
        onChange={onChange}
        open={true}
        onToggle={onToggle}
      />,
    );
    // Click "奇幻冒險" option
    fireEvent.click(screen.getByText("奇幻冒險"));
    expect(onChange).toHaveBeenCalledWith("奇幻冒險");
    expect(onToggle).toHaveBeenCalled();
  });

  it("calls onToggle when icon button is clicked", () => {
    const onToggle = vi.fn();
    render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["奇幻冒險", "韓國耽美"])}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByLabelText("篩選分類"));
    expect(onToggle).toHaveBeenCalled();
  });

  it("deduplicates categories", () => {
    render(
      <CategoryFilter
        {...defaultProps}
        books={makeBooks(["奇幻冒險", "奇幻冒險", "韓國耽美"])}
        open={true}
      />,
    );
    const options = screen.getAllByRole("option");
    // "全部分類" + 2 unique categories
    expect(options).toHaveLength(3);
  });

  describe("responsive sizing", () => {
    // The 40px (desktop) / 32px (mobile) trigger sizing moved from inline styles
    // to `.moo-category__trigger` + the `--mobile` modifier in styles.css. jsdom
    // does not apply stylesheet rules, so the observable contract is the modifier
    // class presence/absence.
    const books = makeBooks(["奇幻冒險", "韓國耽美", "軍事戰略"]);

    it("renders a desktop trigger without the --mobile modifier", () => {
      vi.mocked(useIsMobile).mockReturnValue(false);
      render(<CategoryFilter {...defaultProps} books={books} />);
      const trigger = screen.getByLabelText("篩選分類");
      expect(trigger).toHaveClass("moo-category__trigger");
      expect(trigger).not.toHaveClass("moo-category__trigger--mobile");
    });

    it("adds the --mobile modifier on the trigger on mobile", () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(<CategoryFilter {...defaultProps} books={books} />);
      const trigger = screen.getByLabelText("篩選分類");
      expect(trigger).toHaveClass("moo-category__trigger");
      expect(trigger).toHaveClass("moo-category__trigger--mobile");
    });
  });

  // CategoryFilter is controlled (`open` / `onToggle` live in the parent), so a
  // small stateful parent drives it the way FamilyShelf / PersonalShelf do and
  // lets the menu genuinely unmount on close. Focus starts on an option — where
  // a keyboard user is while the menu is open — so a focus that is NOT moved
  // falls to <body> when that option unmounts.
  describe("focus after closing", () => {
    function StatefulFilter({ onChange }: { onChange: (v: string) => void }) {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState("");
      return (
        <div>
          <button type="button">outside</button>
          <CategoryFilter
            books={makeBooks(["奇幻冒險", "韓國耽美"])}
            value={value}
            onChange={(next) => {
              onChange(next);
              setValue(next);
            }}
            open={open}
            onToggle={() => setOpen((prev) => !prev)}
          />
        </div>
      );
    }

    /** Opens the menu, focuses the option labelled `label`, returns it. */
    function openAndFocusOption(label: string): HTMLElement {
      fireEvent.click(screen.getByLabelText("篩選分類"));
      const option = screen
        .getAllByRole("option")
        .find((o) => o.firstElementChild?.textContent === label);
      if (!option) throw new Error(`option not found: ${label}`);
      option.focus();
      expect(option).toHaveFocus();
      return option;
    }

    it.each<{ label: string; expected: string }>([
      { label: "全部分類", expected: "" },
      { label: "奇幻冒險", expected: "奇幻冒險" },
    ])(
      "returns focus to the trigger after choosing $label",
      ({ label, expected }) => {
        const onChange = vi.fn();
        render(<StatefulFilter onChange={onChange} />);
        const option = openAndFocusOption(label);

        fireEvent.click(option);

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(expected);
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(screen.getByLabelText("篩選分類")).toHaveFocus();
      },
    );

    it("returns focus to the trigger when Escape closes the menu", () => {
      const onChange = vi.fn();
      render(<StatefulFilter onChange={onChange} />);
      const option = openAndFocusOption("韓國耽美");

      fireEvent.keyDown(option, { key: "Escape" });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.getByLabelText("篩選分類")).toHaveFocus();
      expect(onChange).not.toHaveBeenCalled();
    });

    // Negative companion: the user went elsewhere, so focus is not pulled back.
    it("does not move focus to the trigger on an outside mousedown", () => {
      render(<StatefulFilter onChange={vi.fn()} />);
      openAndFocusOption("韓國耽美");

      fireEvent.mouseDown(screen.getByText("outside"));

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.getByLabelText("篩選分類")).not.toHaveFocus();
    });
  });
});

describe("filterByCategory", () => {
  const items = [
    { category: "奇幻冒險", title: "Book A" },
    { category: "韓國耽美", title: "Book B" },
    { category: "", title: "Book C" },
    { category: "奇幻冒險", title: "Book D" },
  ];

  it("returns all items when category is empty string", () => {
    expect(filterByCategory(items, "")).toEqual(items);
  });

  it("filters by specific category", () => {
    const result = filterByCategory(items, "奇幻冒險");
    expect(result).toHaveLength(2);
    expect(result.every((b) => b.category === "奇幻冒險")).toBe(true);
  });

  it("filters uncategorized books when category is 未分類", () => {
    const result = filterByCategory(items, "未分類");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Book C");
  });

  it("returns empty array when no books match", () => {
    expect(filterByCategory(items, "不存在的分類")).toHaveLength(0);
  });
});
