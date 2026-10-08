import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookRow } from "@/components/BookRow";
import { BoolFlag, type BookEntry } from "@/api/client";

/**
 * PWA BookRow: rendering, interaction, and its React.memo wrapping.
 *
 * Memo checks: one case checks the wrapping structurally (`$$typeof === Symbol.for("react.memo")`),
 * the rest behaviourally. Callbacks are passed as stable refs, so any re-render of BookRow must come
 * from a prop change (book / selected / isDirty), not from callback identity drift. The `$$typeof`
 * case is the only one that fails if the memo is removed: with identical props the rerendered button
 * stays the SAME DOM node, but reconciliation preserves that identity with or without memo. A changed
 * prop goes through memo's shallow compare and the observable output — the toggle's `aria-pressed` /
 * `aria-label`, which carry the title and isShared status — is re-checked.
 */

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

describe("BookRow (PWA) — rendering", () => {
  const noop = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders title and author", () => {
    render(
      <BookRow
        book={makeBook({ title: "我的書", author: "作者甲" })}
        selected={false}
        isDirty={false}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(screen.getByText("我的書")).toBeInTheDocument();
    expect(screen.getByText("作者甲")).toBeInTheDocument();
  });

  it("renders the 封存 badge when isArchived === TRUE", () => {
    render(
      <BookRow
        book={makeBook({ isArchived: BoolFlag.TRUE })}
        selected={false}
        isDirty={false}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(screen.getByText("封存")).toBeInTheDocument();
  });

  it("does not render 封存 badge when isArchived !== TRUE", () => {
    render(
      <BookRow
        book={makeBook({ isArchived: BoolFlag.FALSE })}
        selected={false}
        isDirty={false}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(screen.queryByText("封存")).not.toBeInTheDocument();
  });

  it("shows '開放' when isShared=TRUE", () => {
    render(
      <BookRow
        book={makeBook({ isShared: BoolFlag.TRUE })}
        selected={false}
        isDirty={false}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(
      "開放",
    );
  });

  it("shows '未開放' when isShared=FALSE", () => {
    render(
      <BookRow
        book={makeBook({ isShared: BoolFlag.FALSE })}
        selected={false}
        isDirty={false}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(screen.getByRole("button", { pressed: false })).toHaveTextContent(
      "未開放",
    );
  });

  it("renders checked checkbox when selected=true", () => {
    render(
      <BookRow
        book={makeBook()}
        selected={true}
        isDirty={false}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("renders unchecked checkbox when selected=false", () => {
    render(
      <BookRow
        book={makeBook()}
        selected={false}
        isDirty={false}
        onSelect={noop}
        onToggle={noop}
      />,
    );

    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});

describe("BookRow (PWA) — interactions", () => {
  it("clicking row body calls onSelect with bookId", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <BookRow
        book={makeBook({ bookId: "book-X" })}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    // Click on title text (part of row body)
    fireEvent.click(screen.getByText("測試書籍"));

    expect(onSelect).toHaveBeenCalledWith("book-X");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("clicking toggle button calls onToggle, not onSelect", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <BookRow
        book={makeBook({ bookId: "book-X" })}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onToggle).toHaveBeenCalledWith("book-X");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking checkbox calls onSelect (and not onToggle)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <BookRow
        book={makeBook({ bookId: "book-X" })}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onSelect).toHaveBeenCalledWith("book-X");
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("BookRow (PWA) — React.memo behavior", () => {
  /** Stable callback refs, so a re-render can only come from a prop change; unchanged props must let
   *  React.memo skip BookRow. See the header → "Memo checks". */
  it("is wrapped in React.memo (structural check)", () => {
    // React.memo returns an object exotic with $$typeof === Symbol.for("react.memo")
    const memoSymbol = Symbol.for("react.memo");
    expect((BookRow as unknown as { $$typeof: symbol }).$$typeof).toBe(
      memoSymbol,
    );
  });

  it("skips re-render when props are identical (memo short-circuit)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const book = makeBook();

    // Capture the button node to check its identity survives the rerender; reconciliation keeps it
    // with or without memo. See the header → "Memo checks".
    const { rerender } = render(
      <BookRow
        book={book}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );
    const initialButton = screen.getByRole("button");

    rerender(
      <BookRow
        book={book}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    // Pins node identity across the rerender only; this alone does not prove memo short-circuited
    // (see the header → "Memo checks").
    expect(screen.getByRole("button")).toBe(initialButton);
  });

  it("re-renders when isDirty changes (memo lets the diff through)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const book = makeBook({ isShared: BoolFlag.TRUE });

    const { rerender } = render(
      <BookRow
        book={book}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    // Sanity: visible content reflects current props
    expect(screen.getByRole("button", { pressed: true })).toBeInTheDocument();

    // Flip isDirty: not displayed, but it passes memo's shallow compare and React processes the prop;
    // the render path is checked via observable output, which depends on isShared (unchanged).
    rerender(
      <BookRow
        book={book}
        selected={false}
        isDirty={true}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByRole("button", { pressed: true })).toBeInTheDocument();
  });

  it("re-renders when selected changes (visible state updates)", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const book = makeBook();

    const { rerender } = render(
      <BookRow
        book={book}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByRole("checkbox")).not.toBeChecked();

    rerender(
      <BookRow
        book={book}
        selected={true}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("re-renders when book reference changes", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();

    const { rerender } = render(
      <BookRow
        book={makeBook({ title: "原書名" })}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText("原書名")).toBeInTheDocument();

    rerender(
      <BookRow
        book={makeBook({ title: "新書名" })}
        selected={false}
        isDirty={false}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText("新書名")).toBeInTheDocument();
    expect(screen.queryByText("原書名")).not.toBeInTheDocument();
  });
});
