import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BookCard, FilterButton, BookWithMember } from "@/dialog/BookCard";
import { BoolFlag } from "@/api/client";

function makeBook(overrides: Partial<BookWithMember> = {}): BookWithMember {
  return {
    bookId: "book-1",
    title: "測試書籍",
    author: "測試作者",
    isbn: "",
    // Must sit on a Readmoo cover host: the card filters `coverUrl` through
    // `safeCoverUrl` (extension/src/dialog/safeCoverUrl.ts) at render time, so
    // any other host yields "" and no <img> is emitted at all.
    coverUrl: "https://cdn.readmoo.com/cover/test.jpg",
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    isShared: BoolFlag.FALSE,
    isUpdated: BoolFlag.FALSE,
    memberName: "小明",
    ...overrides,
  };
}

describe("BookCard", () => {
  it("renders a cover image with alt text", () => {
    render(<BookCard book={makeBook()} />);

    const img = screen.getByAltText("測試書籍") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe("https://cdn.readmoo.com/cover/test.jpg");
  });

  /**
   * Cover URLs on a family book arrive from the SERVER, and the dialog is
   * injected into Readmoo pages that send no CSP — so this render-time filter
   * is the only thing between a stored tracking beacon and every viewer's
   * IP / UA. A rejected URL must degrade to the empty-cover placeholder, never
   * reach an `<img src>`.
   */
  it("drops a non-Readmoo cover URL and renders the fallback instead", () => {
    const { container } = render(
      <BookCard
        book={makeBook({ coverUrl: "https://evil.example/beacon.gif" })}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByAltText("測試書籍")).not.toBeInTheDocument();
    // Nothing anywhere in the tree may reference the hostile host.
    expect(container.innerHTML).not.toContain("evil.example");
    expect(
      container.querySelector(".moo-book-card__cover-fallback"),
    ).not.toBeNull();
  });

  it("wraps cover image in a link to readmooUrl", () => {
    render(<BookCard book={makeBook()} />);

    const img = screen.getByAltText("測試書籍");
    const link = img.closest("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toBe("https://readmoo.com/book/book-1");
    expect(link.target).toBe("_blank");
    // Full string, not `toContain("noopener")`: the two tokens do different
    // jobs, so a substring check stays green after the load-bearing half is
    // deleted. `noopener` severs `window.opener`; `noreferrer` is the one
    // that suppresses the Referer header. Production documents the pair as
    // load-bearing (shared/src/config/readmoo.ts → isAllowedBookUrl), and it
    // is the layer that still holds when the URL whitelist is bypassed —
    // which has happened: see the base-sensitivity rows in
    // tests/unit/readmooConfig.test.ts.
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("renders the book title inside the link to readmooUrl", () => {
    render(<BookCard book={makeBook()} />);

    // After the v1.5.0 reshape the title is a span wrapped by the cover/info link.
    const title = screen.getByText("測試書籍");
    expect(title.tagName).toBe("SPAN");
    const link = title.closest("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toBe("https://readmoo.com/book/book-1");
    expect(link.target).toBe("_blank");
  });

  it("title carries the scoped title class (2-line clamp lives in styles.css)", () => {
    // After the Shadow DOM + scoped-CSS conversion the clamp/ellipsis rules moved
    // out of inline styles into `.moo-book-card__title` in styles.css. jsdom does
    // not apply stylesheet rules, so the observable contract is now the class.
    render(<BookCard book={makeBook()} />);

    const title = screen.getByText("測試書籍") as HTMLElement;
    expect(title).toHaveClass("moo-book-card__title");
  });

  it("renders author when present", () => {
    render(<BookCard book={makeBook({ author: "作者A" })} />);

    expect(screen.getByText("作者A")).toBeInTheDocument();
  });

  it("does not render author span when author is empty", () => {
    const { container } = render(<BookCard book={makeBook({ author: "" })} />);

    // The author is rendered in a span carrying `.moo-book-card__author`.
    expect(container.querySelector(".moo-book-card__author")).toBeNull();
  });

  it("renders the author in a span carrying the scoped author class when present", () => {
    render(<BookCard book={makeBook({ author: "作者A" })} />);

    const author = screen.getByText("作者A");
    expect(author.tagName).toBe("SPAN");
    expect(author).toHaveClass("moo-book-card__author");
  });

  it("renders member name badge", () => {
    render(<BookCard book={makeBook({ memberName: "大明" })} />);

    const badge = screen.getByText("大明");
    expect(badge).toBeInTheDocument();
    expect(badge.tagName).toBe("SPAN");
  });

  it("member name badge carries the scoped member class (blue styling in styles.css)", () => {
    render(<BookCard book={makeBook({ memberName: "小明" })} />);

    const badge = screen.getByText("小明");
    expect(badge).toHaveClass("moo-book-card__member");
  });

  it("renders the 更新 badge when isUpdated is TRUE", () => {
    render(<BookCard book={makeBook({ isUpdated: BoolFlag.TRUE })} />);

    const badge = screen.getByLabelText("新分享書籍");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("更新");
    expect(badge).toHaveClass("moo-book-card__updated-badge");
  });

  it("does not render the 更新 badge when isUpdated is FALSE", () => {
    render(<BookCard book={makeBook({ isUpdated: BoolFlag.FALSE })} />);

    expect(screen.queryByLabelText("新分享書籍")).not.toBeInTheDocument();
    expect(screen.queryByText("更新")).not.toBeInTheDocument();
  });

  it("renders with a long title without error", () => {
    const longTitle =
      "這是一個非常長的書名，用來測試文字截斷功能是否正常運作，超過兩行後應該要顯示省略號";
    render(<BookCard book={makeBook({ title: longTitle })} />);

    expect(screen.getByText(longTitle)).toBeInTheDocument();
  });

  it("does not render category label", () => {
    render(<BookCard book={makeBook({ category: "韓國耽美" })} />);

    // Category should not be displayed on BookCard
    expect(screen.queryByText("韓國耽美")).not.toBeInTheDocument();
  });

  /**
   * `readmooUrl` on a family book arrives from the SERVER, so a family member
   * who bypasses the UI and POSTs a book record can choose it freely. It lands
   * in an `<a href>` that wraps the cover AND the title, so following it looks
   * exactly like opening the book on Readmoo — an arbitrary-redirect / phishing
   * lure, and the destination host learns the viewer's IP and User-Agent the
   * moment the navigation lands. What it does NOT leak is the referer, and only
   * because the render site pairs the href with `rel="noopener noreferrer"`
   * (extension/src/dialog/BookCard.tsx), where `noreferrer` suppresses the
   * Referer header outright. That attribute is load-bearing, not decoration:
   * removing it adds a referer leak on top of everything below.
   *
   * Firing takes a click, unlike a cover URL that loads on render — that lowers
   * the rate, not the severity, since the click happens precisely when the user
   * believes they are opening Readmoo. Nothing in the browser constrains where
   * it goes: the dialog is injected into Readmoo pages, which send no CSP, and
   * `img-src` would say nothing about a navigation anyway (that is why this is
   * a separate defence from the `safeCoverUrl` gate above, not a second use of
   * it). `safeBookUrl` (extension/src/dialog/safeBookUrl.ts) is the only thing
   * between the stored value and the click.
   *
   * The degradation contract is `href={safeBookUrl(...) || undefined}`: the
   * attribute is OMITTED rather than set to `""`, because an empty `href`
   * resolves to the current document and a click would reload the Readmoo page
   * the dialog lives in. With no `href` the `<a>` has no `link` role and is
   * inert, while the card's layout and content stay untouched.
   */
  describe("book link whitelist", () => {
    const PHISHING_URL = "https://evil.example.com/phish";

    // Role-level positive control for the negative cases below: the assertions
    // on the href VALUE live in the two "link to readmooUrl" tests above, this
    // one pins that a whitelisted URL is what makes the <a> a `link` at all.
    it("exposes a link role for a Readmoo book URL", () => {
      render(<BookCard book={makeBook()} />);

      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "https://readmoo.com/book/book-1",
      );
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
        const { container } = render(
          <BookCard book={makeBook({ readmooUrl })} />,
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
        <BookCard book={makeBook({ readmooUrl: PHISHING_URL })} />,
      );

      // The hostile host must not survive anywhere in the markup.
      expect(container.innerHTML).not.toContain("evil.example.com");
      expect(screen.getByAltText("測試書籍")).toBeInTheDocument();
      expect(screen.getByText("測試書籍")).toHaveClass("moo-book-card__title");
      expect(screen.getByText("測試作者")).toBeInTheDocument();
      expect(screen.getByText("小明")).toBeInTheDocument();
    });
  });

  describe("hide action overflow menu (v1.5.0)", () => {
    it("renders the overflow trigger when both onHideToggle and label are provided", () => {
      render(
        <BookCard
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
        <BookCard
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
        <BookCard
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
      render(<BookCard book={makeBook()} hideActionLabel="隱藏書籍" />);
      expect(
        screen.queryByRole("button", { name: "更多選項" }),
      ).not.toBeInTheDocument();
    });

    it("does not render the overflow trigger when label is missing", () => {
      render(<BookCard book={makeBook()} onHideToggle={() => {}} />);
      expect(
        screen.queryByRole("button", { name: "更多選項" }),
      ).not.toBeInTheDocument();
    });

    it("calls onHideToggle when the menuitem is clicked", () => {
      const onHideToggle = vi.fn();
      render(
        <BookCard
          book={makeBook()}
          onHideToggle={onHideToggle}
          hideActionLabel="隱藏書籍"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "隱藏書籍" }));
      expect(onHideToggle).toHaveBeenCalledTimes(1);
    });

    it("does NOT expose favorite as an overflow menu item (it is a heart button)", () => {
      render(
        <BookCard
          book={makeBook()}
          onHideToggle={() => {}}
          hideActionLabel="隱藏書籍"
          onFavoriteToggle={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "更多選項" }));
      expect(
        screen.queryByRole("menuitem", { name: "加入最愛" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", { name: "取消最愛" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("favorite heart button (v1.5.0)", () => {
    it("renders the heart button (always visible) when onFavoriteToggle is provided", () => {
      render(<BookCard book={makeBook()} onFavoriteToggle={() => {}} />);
      expect(
        screen.getByRole("button", { name: "加入最愛" }),
      ).toBeInTheDocument();
    });

    it("does not render the heart button when onFavoriteToggle is missing", () => {
      render(<BookCard book={makeBook()} />);
      expect(
        screen.queryByRole("button", { name: "加入最愛" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "取消最愛" }),
      ).not.toBeInTheDocument();
    });

    it("shows the filled/pressed state and 取消最愛 label when isFavorite is true", () => {
      render(
        <BookCard book={makeBook()} isFavorite onFavoriteToggle={() => {}} />,
      );
      const heart = screen.getByRole("button", { name: "取消最愛" });
      expect(heart).toHaveAttribute("aria-pressed", "true");
    });

    it("shows the hollow/unpressed state when isFavorite is false", () => {
      render(<BookCard book={makeBook()} onFavoriteToggle={() => {}} />);
      const heart = screen.getByRole("button", { name: "加入最愛" });
      expect(heart).toHaveAttribute("aria-pressed", "false");
    });

    it("calls onFavoriteToggle when the heart is clicked", () => {
      const onFavoriteToggle = vi.fn();
      render(
        <BookCard book={makeBook()} onFavoriteToggle={onFavoriteToggle} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "加入最愛" }));
      expect(onFavoriteToggle).toHaveBeenCalledTimes(1);
    });

    it("renders both the heart and the borrow button in the always-visible action row", () => {
      render(
        <BookCard
          book={makeBook()}
          showBorrowButton
          onBorrowClick={() => {}}
          onHideToggle={() => {}}
          hideActionLabel="隱藏書籍"
          onFavoriteToggle={() => {}}
        />,
      );
      expect(
        screen.getByRole("button", { name: "申請借閱" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "加入最愛" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "更多選項" }),
      ).toBeInTheDocument();
    });
  });
});

describe("FilterButton", () => {
  it("renders label text", () => {
    render(<FilterButton label="全部" active={false} onClick={() => {}} />);

    expect(screen.getByText("全部")).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<FilterButton label="全部" active={false} onClick={onClick} />);

    fireEvent.click(screen.getByText("全部"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("adds the --active modifier class when active is true", () => {
    // The active/inactive visual difference moved from inline styles to the
    // `.moo-filter-btn--active` modifier class (styles.css). The modifier class
    // is the observable behavioural contract in jsdom.
    render(<FilterButton label="已開放" active={true} onClick={() => {}} />);

    const btn = screen.getByText("已開放");
    expect(btn).toHaveClass("moo-filter-btn");
    expect(btn).toHaveClass("moo-filter-btn--active");
  });

  it("omits the --active modifier class when active is false", () => {
    render(<FilterButton label="已開放" active={false} onClick={() => {}} />);

    const btn = screen.getByText("已開放");
    expect(btn).toHaveClass("moo-filter-btn");
    expect(btn).not.toHaveClass("moo-filter-btn--active");
  });

  it("renders as a button element", () => {
    render(<FilterButton label="測試" active={false} onClick={() => {}} />);

    expect(screen.getByRole("button", { name: "測試" })).toBeInTheDocument();
  });
});
