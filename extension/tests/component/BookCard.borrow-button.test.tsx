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
 * After the v1.5.0 reshape the action row (borrow + favorite + hide) is ALWAYS
 * visible — there is no hover overlay. Borrow keeps the "申請借閱" / "申請中"
 * semantics and is only rendered when showBorrowButton is true.
 */
describe("BookCard borrow button", () => {
  it("does not render a borrow button when showBorrowButton is omitted", () => {
    render(<BookCard book={makeBook()} />);

    expect(screen.queryByText("申請借閱")).not.toBeInTheDocument();
    expect(screen.queryByText("申請中")).not.toBeInTheDocument();
  });

  it("does not render a borrow button when showBorrowButton is false", () => {
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={false}
        onBorrowClick={() => {}}
      />,
    );

    expect(screen.queryByText("申請借閱")).not.toBeInTheDocument();
  });

  it("renders the 申請借閱 button (always visible) when showBorrowButton is true", () => {
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        onBorrowClick={() => {}}
      />,
    );

    const btn = screen.getByRole("button", { name: "申請借閱" });
    expect(btn).toBeInTheDocument();
    expect(btn.tagName).toBe("BUTTON");
    // Enabled (non-pending) state omits the --pending modifier class.
    expect(btn).toHaveClass("moo-borrow-btn");
    expect(btn).not.toHaveClass("moo-borrow-btn--pending");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
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

    const btn = screen.getByRole("button", {
      name: "申請中",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Pending state adds the --pending modifier class (styles the disabled look).
    expect(btn).toHaveClass("moo-borrow-btn");
    expect(btn).toHaveClass("moo-borrow-btn--pending");
  });

  it("does NOT call onBorrowClick when the button is disabled (pending)", () => {
    const onBorrowClick = vi.fn();
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        borrowRequestPending={true}
        onBorrowClick={onBorrowClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申請中" }));

    expect(onBorrowClick).not.toHaveBeenCalled();
  });

  it("calls onBorrowClick exactly once when the borrow button is clicked", () => {
    const onBorrowClick = vi.fn();
    render(
      <BookCard
        book={makeBook()}
        showBorrowButton={true}
        onBorrowClick={onBorrowClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申請借閱" }));

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

    const result = fireEvent.click(
      screen.getByRole("button", { name: "申請借閱" }),
    );

    // fireEvent.click returns false when defaultPrevented
    expect(result).toBe(false);
    expect(onBorrowClick).toHaveBeenCalledTimes(1);
  });
});
