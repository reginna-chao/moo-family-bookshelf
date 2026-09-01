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

  /**
   * `readmooUrl` is the other attacker-controllable URL on the same server
   * record: a family member can bypass the UI and POST any value, and here the
   * whole ROW is the `<a>`, so a click anywhere on the book follows it. That
   * makes an off-domain value an arbitrary-redirect / phishing lure presented
   * under a legitimate book title, and the destination host learns the viewer's
   * IP and User-Agent. The referer does NOT go with it, purely because the
   * render site pairs the href with `rel="noopener noreferrer"`
   * (pwa/src/components/FamilyBookRow.tsx), where `noreferrer` suppresses the
   * Referer header outright — load-bearing, not decoration. It differs from the
   * cover gate above in when it fires (a click, not a render — lower rate, same
   * severity) and in what could substitute for it: nothing. The CSP in
   * pwa/public/_headers is `img-src` only, which says nothing about where a
   * navigation may go, and that file is in any case only honoured by hosts that
   * serve it. `safeBookUrl` (pwa/src/utils/safeBookUrl.ts) is the whole defence.
   *
   * The degradation contract is `href={safeBookUrl(...) || undefined}`: the
   * attribute is OMITTED rather than set to `""`, because an empty `href`
   * resolves to the current document and a click would reload the PWA. With no
   * `href` the `<a>` has no `link` role and is inert, while the row's layout and
   * content stay untouched. The whitelisted counterpart is pinned by "links to
   * readmooUrl" above.
   */
  describe("book link whitelist", () => {
    const PHISHING_URL = "https://evil.example.com/phish";

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
        const { container } = render(
          <FamilyBookRow book={makeBook({ readmooUrl })} />,
        );

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
      const { container } = render(
        <FamilyBookRow
          book={makeBook({
            readmooUrl: PHISHING_URL,
            coverUrl: "https://cdn.readmoo.com/cover/x.jpg",
          })}
        />,
      );

      // The hostile host must not survive anywhere in the markup.
      expect(container.innerHTML).not.toContain("evil.example.com");
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        "https://cdn.readmoo.com/cover/x.jpg",
      );
      expect(screen.getByText("測試書名")).toBeInTheDocument();
      expect(screen.getByText("測試作者")).toBeInTheDocument();
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    it("keeps the borrow button usable inside an inert anchor", () => {
      // The row's own controls must not be collateral damage: the borrow button
      // lives inside the <a>, and dropping the href must not disable it.
      const onBorrowClick = vi.fn();
      render(
        <FamilyBookRow
          book={makeBook({ readmooUrl: PHISHING_URL })}
          showBorrowButton
          onBorrowClick={onBorrowClick}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "申請借閱" }));
      expect(onBorrowClick).toHaveBeenCalledTimes(1);
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
