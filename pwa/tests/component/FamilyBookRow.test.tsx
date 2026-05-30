import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { FamilyBookRow } from "@/components/FamilyBookRow";
import type { FamilyBookRowBook } from "@/components/FamilyBookRow";
import { BoolFlag } from "@/api/client";

function makeBook(overrides: Partial<FamilyBookRowBook> = {}): FamilyBookRowBook {
  return {
    bookId: "book-1",
    title: "測試書名",
    author: "測試作者",
    isbn: "1234567890",
    coverUrl: "",
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    isShared: BoolFlag.TRUE,
    memberName: "Alice",
    ownerId: "user-2",
    isUpdated: BoolFlag.FALSE,
    ...overrides,
  };
}

describe("FamilyBookRow", () => {
  it("renders title, author, and member name", () => {
    render(<FamilyBookRow book={makeBook()} />);

    expect(screen.getByText("測試書名")).toBeInTheDocument();
    expect(screen.getByText("測試作者")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("shows update badge when isUpdated is TRUE", () => {
    render(<FamilyBookRow book={makeBook({ isUpdated: BoolFlag.TRUE })} />);

    expect(screen.getByLabelText("新分享書籍")).toBeInTheDocument();
  });

  it("does not show update badge when isUpdated is FALSE", () => {
    render(<FamilyBookRow book={makeBook({ isUpdated: BoolFlag.FALSE })} />);

    expect(screen.queryByLabelText("新分享書籍")).not.toBeInTheDocument();
  });

  it("shows borrow button when showBorrowButton is true", () => {
    render(<FamilyBookRow book={makeBook()} showBorrowButton />);

    expect(screen.getByRole("button", { name: "申請借閱" })).toBeInTheDocument();
  });

  it("hides borrow button when showBorrowButton is false", () => {
    render(<FamilyBookRow book={makeBook()} showBorrowButton={false} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onBorrowClick when borrow button is clicked", () => {
    const onBorrowClick = vi.fn();
    render(<FamilyBookRow book={makeBook()} showBorrowButton onBorrowClick={onBorrowClick} />);

    fireEvent.click(screen.getByRole("button", { name: "申請借閱" }));
    expect(onBorrowClick).toHaveBeenCalledTimes(1);
  });

  it("shows disabled button with '申請中' when borrowRequestPending is true", () => {
    render(<FamilyBookRow book={makeBook()} showBorrowButton borrowRequestPending />);

    const button = screen.getByRole("button", { name: "申請中" });
    expect(button).toBeDisabled();
  });

  it("does not call onBorrowClick when borrowRequestPending is true", () => {
    const onBorrowClick = vi.fn();
    render(
      <FamilyBookRow
        book={makeBook()}
        showBorrowButton
        borrowRequestPending
        onBorrowClick={onBorrowClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申請中" }));
    expect(onBorrowClick).not.toHaveBeenCalled();
  });

  it("links to readmooUrl", () => {
    render(<FamilyBookRow book={makeBook()} />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://readmoo.com/book/book-1");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
