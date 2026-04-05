import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BookRow } from "@/dialog/BookRow";
import { BoolFlag, type BookEntry } from "@/api/client";

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId: "book-1",
    title: "測試書籍",
    author: "作者A",
    isbn: "",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    isShared: BoolFlag.FALSE,
    ...overrides,
  };
}

describe("BookRow — archive badge", () => {
  const noop = vi.fn();

  it("renders '封存' badge when book.isArchived === 1", () => {
    render(
      <BookRow book={makeBook({ isArchived: BoolFlag.TRUE })} selected={false} onSelect={noop} onToggle={noop} />,
    );

    expect(screen.getByText("封存")).toBeInTheDocument();
  });

  it("does not render badge when book.isArchived === 0", () => {
    render(
      <BookRow book={makeBook({ isArchived: BoolFlag.FALSE })} selected={false} onSelect={noop} onToggle={noop} />,
    );

    expect(screen.queryByText("封存")).not.toBeInTheDocument();
  });

  it("does not render badge when book.isArchived is undefined", () => {
    render(
      <BookRow book={makeBook({ isArchived: undefined })} selected={false} onSelect={noop} onToggle={noop} />,
    );

    expect(screen.queryByText("封存")).not.toBeInTheDocument();
  });
});

describe("BookRow — category label", () => {
  const noop = vi.fn();

  it("renders category when book.category is non-empty", () => {
    render(
      <BookRow book={makeBook({ category: "奇幻冒險" })} selected={false} onSelect={noop} onToggle={noop} />,
    );
    expect(screen.getByText("奇幻冒險")).toBeInTheDocument();
    expect(screen.getByTitle("分類：奇幻冒險")).toBeInTheDocument();
  });

  it("does not render category when book.category is empty", () => {
    render(
      <BookRow book={makeBook({ category: "" })} selected={false} onSelect={noop} onToggle={noop} />,
    );
    expect(screen.queryByTitle(/分類/)).not.toBeInTheDocument();
  });
});
