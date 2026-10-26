import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { FamilyBookList } from "@/components/FamilyBookList";
import { BoolFlag } from "@/api/client";
import type { BookWithMember } from "@/hooks/useFamilyShelfBooks";

/**
 * FamilyBookList: the PWA family-shelf list that decides, per book, whether the
 * borrow control is shown and hands the pending state down to the row / card.
 *
 * Pending borrow in row view (#381): a book with a borrow request already sent
 * rendered NO borrow control at all in row view, because the list computed
 * `showBorrowButton` with a `!borrowRequestPending` term, and FamilyBookRow only
 * renders its disabled 「申請中」 button when `showBorrowButton` is true. The row
 * component on its own already did the right thing (FamilyBookRow.test.tsx), so
 * the regression could only be caught here, at the list, where the term lived.
 */

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
    ownerId: "user-2",
    isUpdated: BoolFlag.FALSE,
    ...overrides,
  };
}

describe("FamilyBookList", () => {
  it("shows a disabled 申請中 button in row view for another member's book with a pending request", () => {
    const book = makeBook();
    render(
      <FamilyBookList
        books={[book]}
        viewMode="row"
        userId="user-1"
        viewerCanLend={true}
        isFiltering={false}
        hasMore={false}
        totalFilteredCount={1}
        memberCanLendMap={new Map([["user-2", true]])}
        pendingBookIds={new Set([book.bookId])}
        canBorrow={true}
        onBorrow={vi.fn()}
        onToggleHidden={vi.fn()}
        isHidden={() => false}
        isFavorite={() => false}
        onToggleFavorite={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "申請中" })).toBeDisabled();
  });
});
