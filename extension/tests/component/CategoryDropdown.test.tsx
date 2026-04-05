import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CategoryFilter, filterByCategory } from "@/dialog/CategoryDropdown";

function makeBooks(categories: string[]) {
  return categories.map((category, i) => ({ category, bookId: `b${i}` }));
}

describe("CategoryFilter", () => {
  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    open: false,
    onToggle: vi.fn(),
  };

  it("renders nothing when all books share one category", () => {
    const { container } = render(
      <CategoryFilter {...defaultProps} books={makeBooks(["奇幻冒險", "奇幻冒險"])} />,
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
