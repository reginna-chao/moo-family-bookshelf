import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { FamilyBookRow } from "@/dialog/FamilyBookRow";
import { BoolFlag } from "@/api/client";
import type { BookWithMember } from "@/dialog/BookCard";

function makeBook(overrides: Partial<BookWithMember> = {}): BookWithMember {
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

    expect(screen.queryByRole("button", { name: "申請借閱" })).not.toBeInTheDocument();
  });

  it("calls onBorrowClick when borrow button is clicked", () => {
    const onBorrowClick = vi.fn();
    render(<FamilyBookRow book={makeBook()} showBorrowButton onBorrowClick={onBorrowClick} />);

    fireEvent.click(screen.getByRole("button", { name: "申請借閱" }));
    expect(onBorrowClick).toHaveBeenCalledTimes(1);
  });

  it("prevents default on borrow button click", () => {
    const onBorrowClick = vi.fn();
    render(<FamilyBookRow book={makeBook()} showBorrowButton onBorrowClick={onBorrowClick} />);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    screen.getByRole("button", { name: "申請借閱" }).dispatchEvent(event);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("shows disabled state when borrowRequestPending is true", () => {
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

  describe("hide action (v1.5.0)", () => {
    it("renders the hide action button when onHideToggle and label are provided", () => {
      render(
        <FamilyBookRow book={makeBook()} onHideToggle={() => {}} hideActionLabel="隱藏" />,
      );
      expect(screen.getByRole("button", { name: "隱藏" })).toBeInTheDocument();
    });

    it("renders the unhide label in showHidden mode", () => {
      render(
        <FamilyBookRow book={makeBook()} onHideToggle={() => {}} hideActionLabel="取消隱藏" />,
      );
      expect(screen.getByRole("button", { name: "取消隱藏" })).toBeInTheDocument();
    });

    it("does not render the hide action when onHideToggle is missing", () => {
      render(<FamilyBookRow book={makeBook()} hideActionLabel="隱藏" />);
      expect(screen.queryByRole("button", { name: "隱藏" })).not.toBeInTheDocument();
    });

    it("calls onHideToggle when the hide action is clicked", () => {
      const onHideToggle = vi.fn();
      render(
        <FamilyBookRow
          book={makeBook()}
          onHideToggle={onHideToggle}
          hideActionLabel="隱藏"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "隱藏" }));
      expect(onHideToggle).toHaveBeenCalledTimes(1);
    });

    it("prevents default and stops propagation on hide action click", () => {
      const onHideToggle = vi.fn();
      render(
        <FamilyBookRow
          book={makeBook()}
          onHideToggle={onHideToggle}
          hideActionLabel="隱藏"
        />,
      );
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      const stopPropagationSpy = vi.spyOn(event, "stopPropagation");
      screen.getByRole("button", { name: "隱藏" }).dispatchEvent(event);
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(onHideToggle).toHaveBeenCalledTimes(1);
    });
  });
});
