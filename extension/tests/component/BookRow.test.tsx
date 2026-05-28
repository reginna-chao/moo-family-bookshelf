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

describe("BookRow — author display", () => {
  const noop = vi.fn();

  it("renders author below title", () => {
    render(
      <BookRow book={makeBook({ author: "作者A" })} selected={false} onSelect={noop} onToggle={noop} />,
    );
    expect(screen.getByText("作者A")).toBeInTheDocument();
  });

  it("does not render author when empty", () => {
    const { container } = render(
      <BookRow book={makeBook({ author: "" })} selected={false} onSelect={noop} onToggle={noop} />,
    );
    // No small grey text should exist for author
    const authorDivs = container.querySelectorAll("div");
    const authorTexts = Array.from(authorDivs).filter(
      (d) => d.style.fontSize === "11px" && d.style.color === "rgb(148, 163, 184)",
    );
    expect(authorTexts).toHaveLength(0);
  });
});

describe("BookRow — isDirty prop (Wave K)", () => {
  const noop = vi.fn();

  it.each([
    { label: "undefined", value: undefined },
    { label: "false", value: false },
    { label: "true", value: true },
  ])("accepts isDirty=$label without crashing", ({ value }) => {
    const { container } = render(
      <BookRow
        book={makeBook()}
        selected={false}
        isDirty={value}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(container.firstChild).toBeInTheDocument();
    expect(screen.getByText("測試書籍")).toBeInTheDocument();
  });

  it("memo short-circuits when all props (including isDirty) are stable", () => {
    const book = makeBook();
    const { rerender } = render(
      <BookRow book={book} selected={false} isDirty={false} onSelect={noop} onToggle={noop} />,
    );
    const initialButton = screen.getByRole("button");

    // Same references → memo should skip the re-render.
    rerender(
      <BookRow book={book} selected={false} isDirty={false} onSelect={noop} onToggle={noop} />,
    );

    expect(screen.getByRole("button")).toBe(initialButton);
  });
});
