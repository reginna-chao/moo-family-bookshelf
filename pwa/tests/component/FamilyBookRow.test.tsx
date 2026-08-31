import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { FamilyBookRow } from "@/components/FamilyBookRow";
import type { FamilyBookRowBook } from "@/components/FamilyBookRow";
import { BoolFlag } from "@/api/client";

function makeBook(
  overrides: Partial<FamilyBookRowBook> = {},
): FamilyBookRowBook {
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

    expect(
      screen.getByRole("button", { name: "申請借閱" }),
    ).toBeInTheDocument();
  });

  it("hides borrow button when showBorrowButton is false", () => {
    render(<FamilyBookRow book={makeBook()} showBorrowButton={false} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onBorrowClick when borrow button is clicked", () => {
    const onBorrowClick = vi.fn();
    render(
      <FamilyBookRow
        book={makeBook()}
        showBorrowButton
        onBorrowClick={onBorrowClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申請借閱" }));
    expect(onBorrowClick).toHaveBeenCalledTimes(1);
  });

  it("shows disabled button with '申請中' when borrowRequestPending is true", () => {
    render(
      <FamilyBookRow book={makeBook()} showBorrowButton borrowRequestPending />,
    );

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

  /**
   * A family-shelf cover is ANOTHER member's server data, so it is exactly the
   * value a hostile member would point at a tracking beacon to collect every
   * viewer's IP / UA. `safeCoverUrl` (pwa/src/utils/safeCoverUrl.ts) drops it
   * before it becomes an `<img src>`; LazyCover then renders the BookOpen
   * fallback box. The CSP `img-src` in pwa/public/_headers is the second layer
   * (tests/unit/cspHeaders.test.ts) but is only served by Cloudflare Pages /
   * Netlify — `vite dev` / `vite preview` and plain static hosts have only this
   * code filter, which is what the cases below pin.
   */
  describe("cover URL whitelist", () => {
    const READMOO_COVER = "https://cdn.readmoo.com/cover/x.jpg";
    const BEACON_COVER = "https://evil.example/beacon.gif";

    /**
     * LazyCover's BookOpen fallback box. `bg-gray-100` singles it out here: the
     * wrapper LazyCover renders around a live cover carries `relative` and the
     * row's own classes, never a background, so a non-null result means the
     * fallback branch ran. The nested icon is asserted alongside it.
     */
    function coverFallback(container: HTMLElement): Element | null {
      return container.querySelector("div.bg-gray-100");
    }

    // Positive control: without it the negative case below would still pass on
    // a row that never renders a cover at all.
    it("renders a cover served from a Readmoo host", () => {
      const { container } = render(
        <FamilyBookRow book={makeBook({ coverUrl: READMOO_COVER })} />,
      );

      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", READMOO_COVER);
      expect(img).toHaveAttribute("alt", "測試書名");
      expect(coverFallback(container)).toBeNull();
    });

    it("renders no image for a cover on a non-Readmoo host", () => {
      const { container } = render(
        <FamilyBookRow book={makeBook({ coverUrl: BEACON_COVER })} />,
      );

      // No `<img>` ⇒ the browser issues no request ⇒ no IP / UA leak.
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(container.querySelector("img")).toBeNull();
      // The beacon host must not survive anywhere in the markup (src, srcset,
      // a link, a data-* attribute...).
      expect(container.innerHTML).not.toContain("evil.example");
      // The BookOpen fallback box takes the cover's place and holds the layout.
      const fallback = coverFallback(container);
      expect(fallback).not.toBeNull();
      expect(fallback?.querySelector("svg")).not.toBeNull();
      // The row itself must survive a filtered cover.
      expect(screen.getByText("測試書名")).toBeInTheDocument();
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    it("renders the same fallback when the book carries no cover URL", () => {
      const { container } = render(
        <FamilyBookRow book={makeBook({ coverUrl: "" })} />,
      );

      expect(container.querySelector("img")).toBeNull();
      const fallback = coverFallback(container);
      expect(fallback).not.toBeNull();
      expect(fallback?.querySelector("svg")).not.toBeNull();
    });
  });

  describe("hide action overflow menu (v1.5.0)", () => {
    it("renders the overflow trigger when onHideToggle and label are provided", () => {
      render(
        <FamilyBookRow
          book={makeBook()}
          onHideToggle={() => {}}
          hideActionLabel="隱藏書籍"
        />,
      );
      expect(
        screen.getByRole("button", { name: "更多選項" }),
      ).toBeInTheDocument();
    });

    it("shows the hide label as a menuitem after opening the menu", () => {
      render(
        <FamilyBookRow
          book={makeBook()}
          onHideToggle={() => {}}
          hideActionLabel="隱藏書籍"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
      expect(
        screen.getByRole("menuitem", { name: "隱藏書籍" }),
      ).toBeInTheDocument();
    });

    it("shows the unhide label as a menuitem in showHidden mode", () => {
      render(
        <FamilyBookRow
          book={makeBook()}
          onHideToggle={() => {}}
          hideActionLabel="取消隱藏"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
      expect(
        screen.getByRole("menuitem", { name: "取消隱藏" }),
      ).toBeInTheDocument();
    });

    it("does not render the overflow trigger when onHideToggle is missing", () => {
      render(<FamilyBookRow book={makeBook()} hideActionLabel="隱藏書籍" />);
      expect(
        screen.queryByRole("button", { name: "更多選項" }),
      ).not.toBeInTheDocument();
    });

    it("calls onHideToggle when the menuitem is clicked", () => {
      const onHideToggle = vi.fn();
      render(
        <FamilyBookRow
          book={makeBook()}
          onHideToggle={onHideToggle}
          hideActionLabel="隱藏書籍"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "隱藏書籍" }));
      expect(onHideToggle).toHaveBeenCalledTimes(1);
    });
  });
});
