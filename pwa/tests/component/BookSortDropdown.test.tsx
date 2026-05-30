import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { BookSortDropdown } from "@/components/BookSortDropdown";
import type { BookSortMode } from "@/utils/sortBooks";

describe("BookSortDropdown", () => {
  it("renders three options", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);

    const select = screen.getByLabelText("書籍排序") as HTMLSelectElement;
    expect(select.options).toHaveLength(3);
    expect(select.options[0].textContent).toBe("預設順序");
    expect(select.options[1].textContent).toBe("依書名排序");
    expect(select.options[2].textContent).toBe("依作者排序");
  });

  it("reflects value prop as selected option", () => {
    render(<BookSortDropdown value="author" onChange={vi.fn()} />);

    const select = screen.getByLabelText("書籍排序") as HTMLSelectElement;
    expect(select.value).toBe("author");
  });

  it.each<{ option: string; expected: BookSortMode }>([
    { option: "default", expected: "default" },
    { option: "title", expected: "title" },
    { option: "author", expected: "author" },
  ])("calls onChange('$expected') when selecting $option", ({ option, expected }) => {
    const onChange = vi.fn();
    render(<BookSortDropdown value="default" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("書籍排序"), { target: { value: option } });
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it("has correct aria-label", () => {
    render(<BookSortDropdown value="default" onChange={vi.fn()} />);
    expect(screen.getByLabelText("書籍排序")).toBeInTheDocument();
  });
});
