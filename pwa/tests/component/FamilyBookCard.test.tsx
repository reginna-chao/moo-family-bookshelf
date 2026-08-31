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
 * Scope of this file: the two server-data URL gates (cover and book link). The
 * card's borrow control, favorite and hide-menu behaviour is covered through
 * FamilyShelfPage's own suites.
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

  /**
   * `readmooUrl` is the other attacker-controllable URL on the same server
   * record, and it lands in an `<a href>` wrapping the cover AND the title — so
   * following it looks exactly like opening the book on Readmoo. That makes an
   * off-domain value an arbitrary-redirect / phishing lure, and the destination
   * host learns the viewer's IP and User-Agent. The referer stays behind, but
   * only because the render site pairs the href with `rel="noopener
   * noreferrer"` (pwa/src/components/FamilyBookCard.tsx) and `noreferrer`
   * suppresses the Referer header outright — load-bearing, not decoration.
   * It differs from the cover gate above in when it fires (a click, not a
   * render — lower rate, same severity) and in what could substitute for it:
   * nothing. The CSP in pwa/public/_headers is `img-src` only, which says
   * nothing about where a navigation may go, and that file is in any case only
   * honoured by hosts that serve it. `safeBookUrl`
   * (pwa/src/utils/safeBookUrl.ts) is the whole defence on this path.
   *
   * The degradation contract is `href={safeBookUrl(...) || undefined}`: the
   * attribute is OMITTED rather than set to `""`, because an empty `href`
   * resolves to the current document and a click would reload the PWA. With no
   * `href` the `<a>` has no `link` role and is inert, while the card's layout
   * and content stay untouched.
   */
  describe("book link whitelist", () => {
    const PHISHING_URL = "https://evil.example.com/phish";

    // Positive control: without it the negative cases below would still pass on
    // a card that never rendered a link at all.
    it("links to a Readmoo book URL", () => {
      renderCard(makeBook());

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "https://readmoo.com/book/book-1");
      expect(link).toHaveAttribute("target", "_blank");
      // Full string, not `toContain("noopener")`: the two tokens do different
      // jobs, so a substring check stays green after the load-bearing half is
      // deleted. `noopener` severs `window.opener`; `noreferrer` is the one
      // that suppresses the Referer header. Production documents the pair as
      // load-bearing (shared/src/config/readmoo.ts → isAllowedBookUrl), and it
      // is the layer that still holds when the URL whitelist is bypassed —
      // which has happened: see the base-sensitivity rows in
      // extension/tests/unit/readmooConfig.test.ts.
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    const rejected: Array<{ name: string; readmooUrl: string }> = [
      { name: "a phishing link on a foreign host", readmooUrl: PHISHING_URL },
      {
        name: "a plain-HTTP link on the Readmoo apex",
        readmooUrl: "http://readmoo.com/book/book-1",
      },
      // Already a legitimate stored value before this filter existed; it must
      // degrade the same way rather than emit `href=""`.
      { name: "an empty stored URL", readmooUrl: "" },
    ];

    for (const { name, readmooUrl } of rejected) {
      it(`renders an inert anchor with no href for ${name}`, () => {
        const { container } = renderCard(makeBook({ readmooUrl }));

        const anchors = container.querySelectorAll("a");
        expect(anchors).toHaveLength(1);
        // Load-bearing assertion, and NOT interchangeable with the role query
        // below: RTL reports no `link` role for `href=""` either, so only the
        // attribute check can tell "omitted" from "empty" — i.e. only this line
        // fails if the `|| undefined` is ever dropped from the render site.
        expect(anchors[0].getAttribute("href")).toBeNull();
        // The role query is what proves the hostile URL never made it in: with
        // the filter removed this anchor would be a real, followable link.
        expect(screen.queryByRole("link")).not.toBeInTheDocument();
      });
    }

    it("degrades the link only — cover, title and owner still render", () => {
      const { container } = renderCard(
        makeBook({ readmooUrl: PHISHING_URL, coverUrl: READMOO_COVER }),
      );

      // The hostile host must not survive anywhere in the markup.
      expect(container.innerHTML).not.toContain("evil.example.com");
      expect(screen.getByRole("img")).toHaveAttribute("src", READMOO_COVER);
      expect(screen.getByText("測試書名")).toBeInTheDocument();
      expect(screen.getByText("測試作者")).toBeInTheDocument();
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
  });
});
