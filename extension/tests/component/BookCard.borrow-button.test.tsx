import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BookCard, BookWithMember } from "@/dialog/BookCard";
import { BoolFlag } from "@/api/client";

function makeBook(overrides: Partial<BookWithMember> = {}): BookWithMember {
  return {
    bookId: "book-1",
    title: "測試書籍",
    author: "測試作者",
    isbn: "",
    coverUrl: "https://example.com/cover.jpg",
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    isShared: BoolFlag.TRUE,
    isUpdated: BoolFlag.FALSE,
    memberName: "Alice",
    ...overrides,
  };
}

/**
 * The borrow button is rendered inside an overlay that becomes visible
 * (and accessible) only on hover. Helper to trigger hover on the card root.
 */
function hoverCard(container: HTMLElement) {
  const cardRoot = container.firstChild as HTMLElement;
  fireEvent.mouseEnter(cardRoot);
}

describe("BookCard borrow button", () => {
  it("does not render any borrow button overlay when showBorrowButton is omitted", () => {
    const { container } = render(<BookCard book={makeBook()} />);

    // The button text is never present (overlay isn't rendered at all)
    expect(screen.queryByText("申請借閱")).not.toBeInTheDocument();
    expect(screen.queryByText("申請中")).not.toBeInTheDocument();
    // Even after hover, no overlay
    hoverCard(container);
    expect(screen.queryByText("申請借閱")).not.toBeInTheDocument();
  });

  it("does not render any borrow button overlay when showBorrowButton is false", () => {
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={false}
        onBorrowClick={() => {}}
      />,
    );

    expect(screen.queryByText("申請借閱")).not.toBeInTheDocument();
  });

  it("renders 申請借閱 button (in hover overlay) when showBorrowButton is true", () => {
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        onBorrowClick={() => {}}
      />,
    );

    // The button is always in the DOM when showBorrowButton=true (revealed on hover via CSS)
    const btn = screen.getByText("申請借閱");
    expect(btn).toBeInTheDocument();
    expect(btn.tagName).toBe("BUTTON");
  });

  it("button is hidden (overlay aria-hidden) before hover and visible after hover", () => {
    const { container } = render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        onBorrowClick={() => {}}
      />,
    );

    const btn = screen.getByText("申請借閱");
    const overlay = btn.parentElement as HTMLElement;
    expect(overlay.getAttribute("aria-hidden")).toBe("true");

    hoverCard(container);

    expect(overlay.getAttribute("aria-hidden")).toBe("false");
  });

  it("renders 申請中 (disabled) when borrowRequestPending is true", () => {
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        borrowRequestPending={true}
        onBorrowClick={() => {}}
      />,
    );

    const btn = screen.getByText("申請中") as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.disabled).toBe(true);
  });

  it("does NOT call onBorrowClick when button is disabled (pending)", () => {
    const onBorrowClick = vi.fn();
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        borrowRequestPending={true}
        onBorrowClick={onBorrowClick}
      />,
    );

    fireEvent.click(screen.getByText("申請中"));

    expect(onBorrowClick).not.toHaveBeenCalled();
  });

  it("calls onBorrowClick exactly once when borrow button is clicked", () => {
    const onBorrowClick = vi.fn();
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        onBorrowClick={onBorrowClick}
      />,
    );

    fireEvent.click(screen.getByText("申請借閱"));

    expect(onBorrowClick).toHaveBeenCalledTimes(1);
  });

  it("borrow button click prevents default (stops anchor navigation)", () => {
    const onBorrowClick = vi.fn();
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        onBorrowClick={onBorrowClick}
      />,
    );

    const btn = screen.getByText("申請借閱");
    const result = fireEvent.click(btn);

    // fireEvent.click returns false when defaultPrevented
    expect(result).toBe(false);
    expect(onBorrowClick).toHaveBeenCalledTimes(1);
  });
});
