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
