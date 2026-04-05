import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CategoryDropdown, filterByCategory } from "@/dialog/CategoryDropdown";

function makeBooks(categories: string[]) {
  return categories.map((category, i) => ({ category, bookId: `b${i}` }));
}

describe("CategoryDropdown", () => {
  it("renders nothing when all books share one category", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CategoryDropdown books={makeBooks(["奇幻冒險", "奇幻冒險"])} value="" onChange={onChange} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when book list is empty", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CategoryDropdown books={[]} value="" onChange={onChange} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders dropdown with multiple categories", () => {
    const onChange = vi.fn();
    render(
      <CategoryDropdown
        books={makeBooks(["奇幻冒險", "韓國耽美", "軍事\\戰略"])}
        value=""
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText("篩選分類");
    expect(select).toBeInTheDocument();

    const options = screen.getAllByRole("option");
    // "全部分類" + 3 categories
    expect(options).toHaveLength(4);
    expect(options[0]).toHaveTextContent("全部分類");
  });

  it("sorts categories alphabetically with 未分類 at the end", () => {
    const onChange = vi.fn();
    render(
      <CategoryDropdown
        books={makeBooks(["韓國耽美", "", "奇幻冒險"])}
        value=""
        onChange={onChange}
      />,
    );
    const options = screen.getAllByRole("option");
    // "全部分類", then sorted categories, then "未分類"
    expect(options[options.length - 1]).toHaveTextContent("未分類");
  });

  it("calls onChange when a category is selected", () => {
    const onChange = vi.fn();
    render(
      <CategoryDropdown
        books={makeBooks(["奇幻冒險", "韓國耽美"])}
        value=""
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText("篩選分類");
    fireEvent.change(select, { target: { value: "奇幻冒險" } });
    expect(onChange).toHaveBeenCalledWith("奇幻冒險");
  });

  it("deduplicates categories", () => {
    const onChange = vi.fn();
    render(
      <CategoryDropdown
        books={makeBooks(["奇幻冒險", "奇幻冒險", "韓國耽美"])}
        value=""
        onChange={onChange}
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
