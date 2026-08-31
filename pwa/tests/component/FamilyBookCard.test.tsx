import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { FamilyBookCard } from "@/components/FamilyBookCard";
import { BoolFlag } from "@/api/client";
import type { BookWithMember } from "@/hooks/useFamilyShelfBooks";

/**
 * `FamilyBookCard` is the GRID-layout twin of `FamilyBookRow` (the default view
 * mode of the family shelf — see useFamilyShelfViewMode), and it renders the
 * same cover data through the same `LazyCover`.
 *
 * A family-shelf cover is ANOTHER member's server data, so it is exactly the
 * value a hostile member would point at a tracking beacon to collect every
 * viewer's IP / UA. `safeCoverUrl` (pwa/src/utils/safeCoverUrl.ts) drops it
 * before it becomes an `<img src>`; LazyCover then renders the BookOpen
 * fallback box. The CSP `img-src` in pwa/public/_headers is the second layer
 * (tests/unit/cspHeaders.test.ts) but is only served by Cloudflare Pages /
 * Netlify — `vite dev` / `vite preview` and plain static hosts have only this
 * code filter, which is what the cases below pin.
 *
 * Scope of this file: the cover gate. The card's borrow control, favorite and
 * hide-menu behaviour is covered through FamilyShelfPage's own suites.
 */

const READMOO_COVER = "https://cdn.readmoo.com/cover/x.jpg";
const BEACON_COVER = "https://evil.example/beacon.gif";

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

function renderCard(book: BookWithMember) {
  return render(
    <FamilyBookCard
      book={book}
      isOwnBook={false}
      showBorrowButton={false}
      borrowRequestPending={false}
      hideActionLabel="隱藏書籍"
      isFavorite={false}
      onBorrowClick={() => {}}
      onHideToggle={() => {}}
      onFavoriteToggle={() => {}}
    />,
  );
}

/**
 * LazyCover's BookOpen fallback box. `bg-gray-100` singles it out here: the
 * wrapper LazyCover renders around a live cover carries `relative` and the
 * card's own classes, never a background, and the overflow trigger's grey is
 * the distinct `hover:bg-gray-100` token. The nested icon is asserted
 * alongside it.
 */
function coverFallback(container: HTMLElement): Element | null {
  return container.querySelector("div.bg-gray-100");
}

describe("FamilyBookCard", () => {
  describe("cover URL whitelist", () => {
    // Positive control: without it the negative cases below would still pass on
    // a card that never renders a cover at all.
    it("renders a cover served from a Readmoo host", () => {
      const { container } = renderCard(makeBook({ coverUrl: READMOO_COVER }));

      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", READMOO_COVER);
      expect(img).toHaveAttribute("alt", "測試書名");
      expect(coverFallback(container)).toBeNull();
    });

    it("renders no image for a cover on a non-Readmoo host", () => {
      const { container } = renderCard(makeBook({ coverUrl: BEACON_COVER }));

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
      // The card itself must survive a filtered cover.
      expect(screen.getByText("測試書名")).toBeInTheDocument();
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    it("renders the same fallback when the book carries no cover URL", () => {
      const { container } = renderCard(makeBook({ coverUrl: "" }));

      expect(container.querySelector("img")).toBeNull();
      const fallback = coverFallback(container);
      expect(fallback).not.toBeNull();
      expect(fallback?.querySelector("svg")).not.toBeNull();
    });
  });
});
