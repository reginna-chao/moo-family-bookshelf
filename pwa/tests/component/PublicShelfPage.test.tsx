import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, act, type RenderResult } from "@testing-library/react";
import React from "react";
import { PublicShelfPage } from "@/pages/PublicShelfPage";

const { mockGetPublicShelf } = vi.hoisted(() => ({
  mockGetPublicShelf: vi.fn(),
}));

// The page constructs its own ApiClient from DEFAULT_API_ENDPOINT, so the class
// itself is replaced. `importOriginal` keeps BoolFlag and the types real.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    ApiClient: vi.fn().mockImplementation(() => ({
      getPublicShelf: mockGetPublicShelf,
    })),
  };
});

import { BoolFlag, type BookEntry } from "@/api/client";

/**
 * A public shelf is served to ANYONE holding the share token — no login, no
 * family membership — so its covers are the widest-reach render of somebody
 * else's server data in the whole PWA. `safeCoverUrl`
 * (pwa/src/utils/safeCoverUrl.ts) drops a cover outside the Readmoo host
 * whitelist, and this page then omits the `<img>` ENTIRELY (rather than
 * emitting `src=""`), so the browser issues no request at all and the book
 * title placeholder shows instead.
 *
 * The CSP `img-src` in pwa/public/_headers is the second layer (pinned by
 * tests/unit/cspImgSrc.test.ts), but `_headers` is only honoured by hosts that
 * serve it (Cloudflare Pages / Netlify) — `vite dev` / `vite preview` and plain
 * static hosts send no CSP and rely on this code filter alone.
 *
 * Scope of this file: the cover gate. The page's load / not-found / search
 * behaviour is out of scope here.
 */

const SHARE_TOKEN = "a".repeat(32);
const READMOO_COVER = "https://cdn.readmoo.com/cover/x.jpg";
const BEACON_COVER = "https://evil.example/beacon.gif";
const BOOK_TITLE = "測試書名";

function makeBook(coverUrl: string): BookEntry {
  return {
    bookId: "book-1",
    title: BOOK_TITLE,
    author: "測試作者",
    isbn: "1234567890",
    coverUrl,
    readmooUrl: "https://readmoo.com/book/book-1",
    category: "",
    isShared: BoolFlag.TRUE,
  };
}

/**
 * Renders the loaded shelf. The `act` wrapper (not `findBy*`) is the readiness
 * signal: only leaving `act` guarantees the resolved fetch's state updates and
 * the pending passive effects have been committed.
 */
async function renderShelfWithCover(coverUrl: string): Promise<RenderResult> {
  mockGetPublicShelf.mockResolvedValue({
    title: "公開書櫃",
    books: [makeBook(coverUrl)],
    createdAt: 1_700_000_000_000,
    expiresAt: null,
  });

  let result!: RenderResult;
  await act(async () => {
    result = render(<PublicShelfPage shareToken={SHARE_TOKEN} />);
  });
  return result;
}

/** The title placeholder that stands in for a missing / rejected cover. */
function coverPlaceholder(container: HTMLElement): Element | null {
  return container.querySelector("div.bg-gray-50");
}

describe("PublicShelfPage", () => {
  beforeEach(() => {
    mockGetPublicShelf.mockReset();
  });

  afterEach(() => {
    // RTL's auto-cleanup unmounts the page (its 300ms search-debounce timer is
    // cleared by the effect's own teardown), so only the mocks are left to
    // reset here.
    vi.clearAllMocks();
  });

  describe("cover URL whitelist", () => {
    // Positive control: without it the negative cases below would still pass on
    // a page that never renders a cover at all.
    it("renders a cover served from a Readmoo host", async () => {
      const { container } = await renderShelfWithCover(READMOO_COVER);

      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", READMOO_COVER);
      expect(img).toHaveAttribute("alt", BOOK_TITLE);
      expect(img).toHaveAttribute("loading", "lazy");
      expect(coverPlaceholder(container)).toBeNull();
    });

    it("renders no image element for a cover on a non-Readmoo host", async () => {
      const { container } = await renderShelfWithCover(BEACON_COVER);

      // No `<img>` ⇒ the browser issues no request ⇒ no IP / UA leak.
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(container.querySelector("img")).toBeNull();
      // The beacon host must not survive anywhere in the markup — the book link
      // is built from bookId, so nothing legitimately echoes the cover URL.
      expect(container.innerHTML).not.toContain("evil.example");
      // The title placeholder takes the cover's place, so the grid keeps its
      // shape and the book stays reachable.
      expect(coverPlaceholder(container)).toHaveTextContent(BOOK_TITLE);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "https://readmoo.com/book/book-1",
      );
    });

    it("renders the same placeholder when the book carries no cover URL", async () => {
      const { container } = await renderShelfWithCover("");

      expect(container.querySelector("img")).toBeNull();
      expect(coverPlaceholder(container)).toHaveTextContent(BOOK_TITLE);
    });
  });
});
