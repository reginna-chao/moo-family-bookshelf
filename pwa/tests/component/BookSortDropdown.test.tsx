import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { BookSortDropdown } from "@/components/BookSortDropdown";
import type { BookSortMode } from "@/utils/sortBooks";

describe("BookSortDropdown", () => {
  it("renders five options with 繁中 labels", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const select = screen.getByLabelText("排序方式") as HTMLSelectElement;
    expect(select.options).toHaveLength(5);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "預設順序",
      "書名 A → Z",
      "書名 Z → A",
      "作者 A → Z",
      "作者 Z → A",
    ]);
  });

  it.each<{ value: BookSortMode }>([
    { value: "default" },
    { value: "title-asc" },
    { value: "title-desc" },
    { value: "author-asc" },
    { value: "author-desc" },
  ])("reflects value prop '$value' as selected option", ({ value }) => {
    render(<BookSortDropdown value={value} onChange={vi.fn()} />);

    const select = screen.getByLabelText("排序方式") as HTMLSelectElement;
    expect(select.value).toBe(value);
  });

  it.each<{ selected: BookSortMode }>([
    { selected: "default" },
    { selected: "title-asc" },
    { selected: "title-desc" },
    { selected: "author-asc" },
    { selected: "author-desc" },
  ])("calls onChange('$selected') when selecting that option", ({ selected }) => {
    const onChange = vi.fn();
    render(<BookSortDropdown value="default" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("排序方式"), { target: { value: selected } });
    expect(onChange).toHaveBeenCalledWith(selected);
  });

  it("has correct aria-label", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);
    expect(screen.getByLabelText("排序方式")).toBeInTheDocument();
  });
});
