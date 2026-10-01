import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag } from "@/api/client";
import { installListTotalPublisher } from "../helpers/listTotalBridge";

describe("scrapeUserEmail", () => {
  let scrapeUserEmail: () => string | null;

  beforeEach(async () => {
    document.body.innerHTML = "";
    vi.resetModules();
    const mod = await import("@/content/scraper");
    scrapeUserEmail = mod.scrapeUserEmail;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns null when .me-panel is not in DOM", () => {
    expect(scrapeUserEmail()).toBeNull();
  });

  it("returns email from a leaf div containing @ and .", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="color: gray;">test@example.com</div>
      </div>
    `;
    expect(scrapeUserEmail()).toBe("test@example.com");
  });

  it("returns null when no div with @ and . exists", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="color: gray;">Just a name</div>
      </div>
    `;
    expect(scrapeUserEmail()).toBeNull();
  });

  it("skips parent divs with child elements", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="color: gray;">
          <span>child@email.com</span>
        </div>
        <div style="color: gray;">actual@email.com</div>
      </div>
    `;
    expect(scrapeUserEmail()).toBe("actual@email.com");
  });

  it("returns first matching email when multiple candidates exist", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="color: gray;">first@example.com</div>
        <div style="color: gray;">second@example.com</div>
      </div>
    `;
    expect(scrapeUserEmail()).toBe("first@example.com");
  });

  it("trims whitespace from email text", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="color: gray;">  user@test.org  </div>
      </div>
    `;
    expect(scrapeUserEmail()).toBe("user@test.org");
  });
});

describe("scrapeDisplayName", () => {
  let scrapeDisplayName: () => string | null;

  beforeEach(async () => {
    document.body.innerHTML = "";
    vi.resetModules();
    const mod = await import("@/content/scraper");
    scrapeDisplayName = mod.scrapeDisplayName;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns null when .me-panel is not in DOM", () => {
    expect(scrapeDisplayName()).toBeNull();
  });

  it("returns display name from div with font-size: 16px", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="font-size: 16px">小明</div>
      </div>
    `;
    expect(scrapeDisplayName()).toBe("小明");
  });

  it("returns null when no matching div found", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="font-size: 14px">小明</div>
      </div>
    `;
    expect(scrapeDisplayName()).toBeNull();
  });

  it("trims whitespace from display name", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="font-size: 16px">  大明  </div>
      </div>
    `;
    expect(scrapeDisplayName()).toBe("大明");
  });

  it("returns null for empty text content", () => {
    document.body.innerHTML = `
      <div class="me-panel">
        <div style="font-size: 16px">   </div>
      </div>
    `;
    expect(scrapeDisplayName()).toBeNull();
  });
});

/**
 * Helper: install a mock fiber bridge responder on document.
 *
 * Listens for `moo-request-fiber-data`, stamps `data-moo-book-id`
 * attributes on matching `.library-item` elements (matching by title),
 * then dispatches `moo-fiber-data` to signal completion.
 * Returns a cleanup function to remove the listener.
 */
function installFiberBridgeMock(
  mockBooks: Array<{ bookId: string; title: string }>,
): () => void {
  const handler = () => {
    // Stamp bookIds onto .library-item elements by matching title
    const items = document.querySelectorAll(".library-item");
    for (const item of items) {
      const titleEl = item.querySelector(".title[title]");
      const title = titleEl?.getAttribute("title");
      const match = mockBooks.find((b) => b.title === title);
      if (match) {
        item.setAttribute("data-moo-book-id", match.bookId);
      }
    }
    document.dispatchEvent(new CustomEvent("moo-fiber-data"));
  };
  document.addEventListener("moo-request-fiber-data", handler);
  return () => document.removeEventListener("moo-request-fiber-data", handler);
}

describe("scrapeBooks", () => {
  let scrapeBooks: () => Promise<import("@/content/scraper").ScrapedBook[]>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
    // vi.resetModules() also gives every case a fresh readmoo-dom module, so the
    // module-scoped legacy-warning de-duplication set never leaks between tests.
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("@/content/scraper");
    scrapeBooks = mod.scrapeBooks;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
  });

  it("returns empty array when no .library-item elements exist", async () => {
    const promise = scrapeBooks();
    // Advance past fiber bridge wait (100ms) + timeout (2000ms)
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }
    const result = await promise;
    expect(result).toEqual([]);
  });

  it("scrapes a library item with privacy fallback ID", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Test Book">Test Book</div></div>
        <img class="cover-img" src="https://example.com/cover.jpg" />
        <div class="privacy" id="privacy-210439468000101"></div>
      </div>
    `;

    const promise = scrapeBooks();

    // Advance past fiber bridge timeout (100ms + 2000ms) + hover wait (120ms)
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("210439468000101");
    expect(result[0].title).toBe("Test Book");
    expect(result[0].coverUrl).toBe("https://example.com/cover.jpg");
  });

  it("skips items without a title", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <img class="cover-img" src="https://example.com/cover.jpg" />
        <div class="privacy" id="privacy-11111"></div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("skips borrowed items", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Borrowed Book">Borrowed Book</div></div>
        <img class="cover-img" src="https://example.com/cover.jpg" />
        <div class="privacy" id="privacy-22222"></div>
        <div type="borrowed"></div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("skips items without bookId (no privacy element and no openbook link)", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="No ID Book">No ID Book</div></div>
        <img class="cover-img" src="https://example.com/cover.jpg" />
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("uses openbook reader-link href when available", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Linked Book">Linked Book</div></div>
        <img class="cover-img" src="https://example.com/cover.jpg" />
        <div class="openbook">
          <a class="reader-link" href="https://readmoo.com/api/reader/210000000123456">Open</a>
        </div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("210000000123456");
    // The legacy host still works, but must announce itself exactly once so we
    // can tell when the `.openbook` fallback is safe to delete.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'legacy selector fallback hit for "scraper:reader-link"',
      ),
    );
  });

  it("extracts bookId from the reader-link under .cover (new site markup)", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="cover-outer">
          <div class="cover-container">
            <div class="cover">
              <a class="reader-link" href="https://readmoo.com/api/reader/210017268000101">
                <img class="cover-img" src="https://cdn.readmoo.com/cover/next-site.jpg" />
              </a>
            </div>
          </div>
          <div class="desktop-overlay">
            <div class="openbook-overlay" style="opacity: 0; pointer-events: none;">
              <div class="detail"><span></span></div>
              <div class="privacy" id="privacy-18548671"><span></span></div>
            </div>
          </div>
        </div>
        <div class="info"><div class="title" title="新站書">新站書</div></div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    // reader-link wins over the .privacy fallback id.
    expect(result[0].bookId).toBe("210017268000101");
    expect(result[0].title).toBe("新站書");
    expect(result[0].coverUrl).toBe(
      "https://cdn.readmoo.com/cover/next-site.jpg",
    );
    // Primary selector hit → no legacy fallback warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the .privacy id when there is no reader-link and the id is a real book id", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="cover-outer">
          <div class="cover-container">
            <div class="cover">
              <img class="cover-img" src="https://cdn.readmoo.com/cover/no-link.jpg" />
            </div>
          </div>
          <div class="desktop-overlay">
            <div class="openbook-overlay" style="opacity: 0; pointer-events: none;">
              <div class="detail"><span></span></div>
              <div class="privacy" id="privacy-210439468000107"><span></span></div>
            </div>
          </div>
        </div>
        <div class="info"><div class="title" title="無連結新站書">無連結新站書</div></div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("210439468000107");
    // Neither reader-link selector matched → nothing to warn about, and the id
    // cleared the length guard so no rejection warning either.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  /**
   * Length guard on the `.privacy` fallback id.
   *
   * The two hosts put different ids in `id="privacy-…"`: the legacy host repeats
   * the real 15-digit book id, the new host exposes an unrelated 8-digit internal
   * id. Accepting the short one would upload a book keyed by an id that resolves
   * to nothing, so the scraper skips the book instead.
   */
  describe("privacy fallback id length guard", () => {
    const cases: Array<{
      name: string;
      privacyId: string;
      expectedBookId: string | null;
    }> = [
      {
        name: "an 8-digit internal id from the new host",
        privacyId: "privacy-18548672",
        expectedBookId: null,
      },
      {
        name: "an 11-digit id (one short of the threshold)",
        privacyId: "privacy-12345678901",
        expectedBookId: null,
      },
      {
        name: "a non-numeric id",
        privacyId: "privacy-abcdefghijklm",
        expectedBookId: null,
      },
      {
        name: "a 12-digit id (the threshold)",
        privacyId: "privacy-123456789012",
        expectedBookId: "123456789012",
      },
      {
        name: "a real 15-digit book id",
        privacyId: "privacy-210439468000108",
        expectedBookId: "210439468000108",
      },
    ];

    for (const { name, privacyId, expectedBookId } of cases) {
      const verb = expectedBookId ? "accepts" : "skips the book for";
      it(`${verb} ${name}`, async () => {
        document.body.innerHTML = `
          <div class="library-item">
            <div class="info"><div class="title" title="守衛書">守衛書</div></div>
            <img class="cover-img" src="https://example.com/cover.jpg" />
            <div class="privacy" id="${privacyId}"></div>
          </div>
        `;

        const promise = scrapeBooks();
        for (let i = 0; i < 25; i++) {
          await vi.advanceTimersByTimeAsync(100);
        }
        const result = await promise;

        if (!expectedBookId) {
          expect(result).toEqual([]);
          // A rejected id is a degraded path the user must be able to see.
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
              `rejected .privacy fallback bookId "${privacyId}"`,
            ),
          );
          return;
        }
        expect(result).toHaveLength(1);
        expect(result[0].bookId).toBe(expectedBookId);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    }

    it("warns once per sync no matter how many books are rejected", async () => {
      document.body.innerHTML = `
        <div class="library-item">
          <div class="info"><div class="title" title="短碼一">短碼一</div></div>
          <div class="privacy" id="privacy-18548672"></div>
        </div>
        <div class="library-item">
          <div class="info"><div class="title" title="短碼二">短碼二</div></div>
          <div class="privacy" id="privacy-18548673"></div>
        </div>
      `;

      const promise = scrapeBooks();
      for (let i = 0; i < 25; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const result = await promise;

      expect(result).toEqual([]);
      // A 25-card library would otherwise bury real errors under 25 identical
      // lines; the label is de-duplicated until the next sync resets it.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("skips borrowed items in the new markup (badge inside .cover)", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="cover-outer">
          <div class="cover-container">
            <div class="cover">
              <div type="borrowed"><div class="ribbon"><span>借入</span></div></div>
              <a class="reader-link" href="https://readmoo.com/api/reader/210017268000102">
                <img class="cover-img" src="https://cdn.readmoo.com/cover/borrowed.jpg" />
              </a>
            </div>
          </div>
          <div class="desktop-overlay">
            <div class="openbook-overlay">
              <div class="privacy" id="privacy-18548672"><span></span></div>
            </div>
          </div>
        </div>
        <div class="info"><div class="title" title="新站借入書">新站借入書</div></div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("extracts bookId from fiber bridge (primary method)", async () => {
    const cleanup = installFiberBridgeMock([
      { bookId: "210439468000101", title: "Fiber Book" },
    ]);

    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Fiber Book">Fiber Book</div></div>
        <img class="cover-img" src="https://cdn.readmoo.com/cover/some-book/cover.jpg" alt="Fiber Book" />
        <div class="privacy" id="privacy-18049960"></div>
      </div>
    `;

    const promise = scrapeBooks();
    // Advance past the 100ms bridge injection delay
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    // Should use fiber bridge bookId, NOT privacy element id
    expect(result[0].bookId).toBe("210439468000101");
    cleanup();
  });

  it("uses correct readmooUrl format from fiber bridge bookId", async () => {
    const cleanup = installFiberBridgeMock([
      { bookId: "310000000000101", title: "URL Test Book" },
    ]);

    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="URL Test Book">URL Test Book</div></div>
        <img class="cover-img" src="https://cdn.readmoo.com/cover/url-test/cover.jpg" alt="URL Test Book" />
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].readmooUrl).toBe(
      "https://readmoo.com/book/310000000000101",
    );
    cleanup();
  });

  it("falls back to DOM extraction when fiber bridge returns no data", async () => {
    // No matching cover URL in fiber bridge response
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Fallback Book">Fallback Book</div></div>
        <img class="cover-img" src="https://example.com/cover.jpg" />
        <div class="privacy" id="privacy-210439468000103"></div>
      </div>
    `;

    const promise = scrapeBooks();
    // Advance past fiber bridge timeout (100ms + 2000ms) + hover wait (120ms)
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("210439468000103");
  });

  it("skips hover when fiber bridge extraction succeeds", async () => {
    const cleanup = installFiberBridgeMock([
      { bookId: "888777666000101", title: "No Hover Book" },
    ]);

    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="No Hover Book">No Hover Book</div></div>
        <img class="cover-img" src="https://cdn.readmoo.com/cover/no-hover/cover.jpg" alt="No Hover Book" />
        <div class="openbook">
          <a class="reader-link" href="https://readmoo.com/api/reader/999">Open</a>
        </div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    // Should use fiber bookId, not the reader-link href id
    expect(result[0].bookId).toBe("888777666000101");
    cleanup();
  });

  it("marks all scraped books with isArchived: 0", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Active Book">Active Book</div></div>
        <img class="cover-img" src="" />
        <div class="privacy" id="privacy-210439468000104"></div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(BoolFlag.FALSE);
  });
});

describe("scrapeArchivedBooks", () => {
  let scrapeArchivedBooks: () => Promise<
    import("@/content/scraper").ScrapeResult
  >;
  let cleanupTotal: (() => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
    vi.resetModules();
    const mod = await import("@/content/scraper");
    scrapeArchivedBooks = mod.scrapeArchivedBooks;
  });

  afterEach(() => {
    cleanupTotal?.();
    cleanupTotal = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
  });

  it("returns an incomplete empty result when filter button is not found in DOM", async () => {
    const promise = scrapeArchivedBooks();
    // Advance past the finally block's wait(2000ms) with clear margin
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    // A failed archive scrape is NOT complete — distinct from zero archived books.
    expect(result).toEqual({ books: [], complete: false });
  });

  it("returns an incomplete empty result when nav buttons exist but none contain i.mo-filter", async () => {
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-search"></i></button>
      <button class="desktop-top-nav-btn"><i class="mo-sort"></i></button>
    `;

    const promise = scrapeArchivedBooks();
    // Advance past the finally block's wait(2000ms) with clear margin
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    // A failed archive scrape is NOT complete — distinct from zero archived books.
    expect(result).toEqual({ books: [], complete: false });
  });

  it("returns an incomplete empty result when filter modal does not appear (timeout)", async () => {
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-filter"></i></button>
    `;

    const promise = scrapeArchivedBooks();

    // Advance past the 3000ms waitForElement timeout + finally block cleanup
    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const result = await promise;
    // A failed archive scrape is NOT complete — distinct from zero archived books.
    expect(result).toEqual({ books: [], complete: false });
  });

  it("returns an incomplete empty result when archive option element not found", async () => {
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-filter"></i></button>
    `;

    const promise = scrapeArchivedBooks();

    await vi.advanceTimersByTimeAsync(200);
    const modal = document.createElement("div");
    modal.className = "filter-modal modal show";
    modal.innerHTML = `
      <div class="modal-footer">
        <button class="btn-primary">確定</button>
      </div>
    `;
    document.body.appendChild(modal);

    // Advance enough for early return + finally block cleanup
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const result = await promise;
    // A failed archive scrape is NOT complete — distinct from zero archived books.
    expect(result).toEqual({ books: [], complete: false });
  }, 15000);

  it("returns scraped books marked with isArchived=1 on success", async () => {
    // Readmoo's own count confirms every archived card was read.
    cleanupTotal = installListTotalPublisher("cards");
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-filter"></i></button>
      <div class="library-item">
        <div class="info"><div class="title" title="Book One">Book One</div></div>
        <img class="cover-img" src="https://example.com/cover1.jpg" />
        <div class="privacy" id="privacy-210439468000105"></div>
      </div>
    `;

    const promise = scrapeArchivedBooks();

    await vi.advanceTimersByTimeAsync(200);
    const modal = document.createElement("div");
    modal.className = "filter-modal modal show";
    modal.innerHTML = `
      <div data-key="archive" data-value="true">已封存書籍</div>
      <div class="modal-footer">
        <button class="btn-primary">確定</button>
        <button class="btn-outline-primary">清除篩選</button>
      </div>
    `;
    document.body.appendChild(modal);

    await vi.advanceTimersByTimeAsync(200);

    await vi.advanceTimersByTimeAsync(300);
    const newItem = document.createElement("div");
    newItem.className = "library-item";
    newItem.innerHTML = `
      <div class="info"><div class="title" title="Archived Book">Archived Book</div></div>
      <img class="cover-img" src="https://example.com/cover2.jpg" />
      <div class="privacy" id="privacy-210439468000106"></div>
    `;
    document.body.appendChild(newItem);

    // Advance through reload polling + fiber bridge timeout + hover + finally cleanup
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const result = await promise;

    expect(result.complete).toBe(true);
    expect(result.books.length).toBeGreaterThan(0);
    for (const book of result.books) {
      expect(book.isArchived).toBe(BoolFlag.TRUE);
    }
    for (const book of result.books) {
      expect(book.bookId).toBeTruthy();
    }
  });
});

/**
 * `scrapeLibrary` completeness (#236). Only a COMPLETE scrape may be used to
 * conclude that a saved book is gone from Readmoo, so every own card that could
 * not be read — and a pagination run that hit its hard cap — must surface as
 * `complete: false`. Borrowed (借入) cards are not the user's books and never
 * make a scrape incomplete.
 *
 * Completeness also needs POSITIVE confirmation (F1): the bridge must publish
 * Readmoo's own list total and it must equal the cards read. Cases that test
 * some OTHER cause of incompleteness publish a matching total ("cards"), so
 * that cause is the only one in play.
 */
describe("scrapeLibrary", () => {
  type ScraperModule = typeof import("@/content/scraper");
  let scrapeLibrary: ScraperModule["scrapeLibrary"];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let cleanupBridge: (() => void) | null = null;
  let cleanupTotal: (() => void) | null = null;

  /** A card whose real id comes from the fiber bridge (no hover) — the control book. */
  const GOOD_CARD = `
    <div class="library-item">
      <div class="info"><div class="title" title="好書">好書</div></div>
      <img class="cover-img" src="https://example.com/good.jpg" />
    </div>
  `;
  const GOOD_ID = "210439468000201";

  function setScrollable(scrollHeight: number, clientHeight: number): void {
    Object.defineProperty(document.documentElement, "scrollHeight", {
      value: scrollHeight,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: clientHeight,
      configurable: true,
    });
  }

  async function runScrape(
    ticks = 40,
    stepMs = 100,
  ): Promise<import("@/content/scraper").ScrapeResult> {
    const promise = scrapeLibrary();
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    return promise;
  }

  function warnMessages(): string[] {
    return warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    scrapeLibrary = (await import("@/content/scraper")).scrapeLibrary;
  });

  afterEach(() => {
    cleanupBridge?.();
    cleanupBridge = null;
    cleanupTotal?.();
    cleanupTotal = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-moo-fiber-bridge");
    setScrollable(0, 0);
  });

  it("is complete when every own card yields a real id and the total matches", async () => {
    cleanupBridge = installFiberBridgeMock([
      { bookId: GOOD_ID, title: "好書" },
    ]);
    cleanupTotal = installListTotalPublisher("cards");
    document.body.innerHTML = GOOD_CARD;

    const result = await runScrape();

    expect(result.complete).toBe(true);
    expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is incomplete when the bridge publishes no list total (unknown ⇒ not confirmed)", async () => {
    cleanupBridge = installFiberBridgeMock([
      { bookId: GOOD_ID, title: "好書" },
    ]);
    document.body.innerHTML = GOOD_CARD;

    const result = await runScrape();

    // Books are still returned (the upload stays additive), only unconfirmed.
    expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
    expect(result.complete).toBe(false);
  });

  it("is incomplete when the published total says a later page has not rendered yet", async () => {
    // F1 regression: the next page is slow, so scrolling stopped growing after
    // one card while Readmoo knows of 3. That must NOT be read as the end of
    // the list (the rename consequence is pinned in syncBooks.reconcile).
    cleanupBridge = installFiberBridgeMock([
      { bookId: GOOD_ID, title: "好書" },
    ]);
    cleanupTotal = installListTotalPublisher(3);
    document.body.innerHTML = GOOD_CARD;

    const result = await runScrape();

    expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
    expect(result.complete).toBe(false);
  });

  it("is incomplete when the published total is SMALLER than the cards read", async () => {
    cleanupBridge = installFiberBridgeMock([
      { bookId: GOOD_ID, title: "好書" },
    ]);
    cleanupTotal = installListTotalPublisher(0);
    document.body.innerHTML = GOOD_CARD;

    const result = await runScrape();

    expect(result.complete).toBe(false);
  });

  it("never reuses a total left on <html> by an earlier request", async () => {
    cleanupBridge = installFiberBridgeMock([
      { bookId: GOOD_ID, title: "好書" },
    ]);
    // A matching value from some earlier request; this bridge publishes none.
    document.documentElement.setAttribute("data-moo-list-total", "1");
    document.body.innerHTML = GOOD_CARD;

    const result = await runScrape();

    expect(result.complete).toBe(false);
    expect(document.documentElement.hasAttribute("data-moo-list-total")).toBe(
      false,
    );
  });

  const unreadableCardCases: Array<{
    name: string;
    card: string;
    fiberId?: string;
    expectedWarning: string | null;
  }> = [
    {
      // The fiber source HAS an id, but not a real one: the search ends there
      // (null) — a valid href on the same card must NOT rescue it.
      name: "a malformed fiber data-moo-book-id (even with a valid reader-link)",
      fiberId: "18548672",
      card: `
        <div class="library-item">
          <div class="info"><div class="title" title="壞書">壞書</div></div>
          <div class="cover">
            <a class="reader-link" href="https://readmoo.com/api/reader/210439468000299">
              <img class="cover-img" src="https://example.com/bad.jpg" />
            </a>
          </div>
        </div>
      `,
      expectedWarning: 'rejected fiber data-moo-book-id bookId "18548672"',
    },
    {
      // Same rule for the href source: a valid .privacy id must not rescue it.
      name: "a malformed reader-link href id (even with a valid .privacy id)",
      card: `
        <div class="library-item">
          <div class="info"><div class="title" title="壞書">壞書</div></div>
          <div class="cover">
            <a class="reader-link" href="https://readmoo.com/api/reader/123456">
              <img class="cover-img" src="https://example.com/bad.jpg" />
            </a>
          </div>
          <div class="privacy" id="privacy-210439468000298"></div>
        </div>
      `,
      expectedWarning: 'rejected reader-link href bookId "123456"',
    },
    {
      name: "a malformed .privacy fallback id",
      card: `
        <div class="library-item">
          <div class="info"><div class="title" title="壞書">壞書</div></div>
          <div class="privacy" id="privacy-18548672"></div>
        </div>
      `,
      expectedWarning: 'rejected .privacy fallback bookId "privacy-18548672"',
    },
    {
      name: "an own card with no id source at all",
      card: `
        <div class="library-item">
          <div class="info"><div class="title" title="壞書">壞書</div></div>
        </div>
      `,
      expectedWarning: null,
    },
    {
      name: "an own card with no title",
      card: `
        <div class="library-item">
          <div class="privacy" id="privacy-210439468000297"></div>
        </div>
      `,
      expectedWarning: null,
    },
  ];

  for (const { name, card, fiberId, expectedWarning } of unreadableCardCases) {
    it(`skips the book and marks the scrape incomplete for ${name}`, async () => {
      const stamps = [{ bookId: GOOD_ID, title: "好書" }];
      if (fiberId) stamps.push({ bookId: fiberId, title: "壞書" });
      cleanupBridge = installFiberBridgeMock(stamps);
      cleanupTotal = installListTotalPublisher("cards");
      document.body.innerHTML = GOOD_CARD + card;

      const result = await runScrape();

      expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
      expect(result.complete).toBe(false);
      if (expectedWarning === null) {
        expect(warnSpy).not.toHaveBeenCalled();
      } else {
        expect(warnMessages()).toEqual([
          expect.stringContaining(expectedWarning),
        ]);
      }
    });
  }

  it("warns once per id source per scrape, under a distinct label for each source", async () => {
    cleanupBridge = installFiberBridgeMock([
      { bookId: "11111111", title: "纖維一" },
      { bookId: "22222222", title: "纖維二" },
    ]);
    cleanupTotal = installListTotalPublisher("cards");
    const titleOnly = (title: string) =>
      `<div class="info"><div class="title" title="${title}">${title}</div></div>`;
    const hrefCard = (title: string, id: string) => `
      <div class="library-item">
        ${titleOnly(title)}
        <div class="cover"><a class="reader-link" href="https://readmoo.com/api/reader/${id}"></a></div>
      </div>
    `;
    document.body.innerHTML = `
      <div class="library-item">${titleOnly("纖維一")}</div>
      <div class="library-item">${titleOnly("纖維二")}</div>
      ${hrefCard("連結一", "333")}
      ${hrefCard("連結二", "444")}
    `;

    const result = await runScrape(60);

    expect(result).toEqual({ books: [], complete: false });
    const messages = warnMessages();
    expect(messages).toHaveLength(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'rejected fiber data-moo-book-id bookId "11111111"',
        ),
        expect.stringContaining('rejected reader-link href bookId "333"'),
      ]),
    );
  });

  it("stays complete when the only skipped card is a borrowed (借入) one", async () => {
    cleanupBridge = installFiberBridgeMock([
      { bookId: GOOD_ID, title: "好書" },
    ]);
    // Readmoo's total COUNTS the borrowed-in card (2 cards, 1 own book).
    cleanupTotal = installListTotalPublisher(2);
    document.body.innerHTML = `
      ${GOOD_CARD}
      <div class="library-item">
        <div class="info"><div class="title" title="借來的">借來的</div></div>
        <div class="privacy" id="privacy-18548672"></div>
        <div type="borrowed"></div>
      </div>
    `;

    const result = await runScrape();

    expect(result.complete).toBe(true);
    expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
  });

  describe("pagination", () => {
    function addBorrowedCard(): void {
      const div = document.createElement("div");
      div.className = "library-item";
      div.innerHTML = `
        <div class="info"><div class="title" title="借入">借入</div></div>
        <div type="borrowed"></div>
      `;
      document.body.appendChild(div);
    }

    it("is incomplete when pagination stops at its hard cap", async () => {
      cleanupBridge = installFiberBridgeMock([
        { bookId: GOOD_ID, title: "好書" },
      ]);
      cleanupTotal = installListTotalPublisher("cards");
      document.body.innerHTML = GOOD_CARD;
      setScrollable(5000, 800);
      // Every scroll loads another card → the list never runs out.
      vi.spyOn(window, "scrollTo").mockImplementation(() => addBorrowedCard());

      const result = await runScrape(140, 500);

      expect(warnMessages()).toEqual([expect.stringContaining("hard cap")]);
      expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
      expect(result.complete).toBe(false);
    });

    it("is complete when pagination runs out of pages and the total confirms it", async () => {
      cleanupBridge = installFiberBridgeMock([
        { bookId: GOOD_ID, title: "好書" },
      ]);
      // Read after pagination: GOOD + the card the scroll loaded = 2.
      cleanupTotal = installListTotalPublisher("cards");
      document.body.innerHTML = GOOD_CARD;
      setScrollable(5000, 800);
      // One more page loads, then nothing — the normal end of the list.
      vi.spyOn(window, "scrollTo")
        .mockImplementationOnce(() => addBorrowedCard())
        .mockImplementation(() => {});

      const result = await runScrape(40, 500);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(result.complete).toBe(true);
      expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
    });

    it("is incomplete when scrolling stops growing but Readmoo holds more items (slow next page)", async () => {
      cleanupBridge = installFiberBridgeMock([
        { bookId: GOOD_ID, title: "好書" },
      ]);
      // Readmoo knows of 5 items; only 2 ever render before scrolling stalls.
      cleanupTotal = installListTotalPublisher(5);
      document.body.innerHTML = GOOD_CARD;
      setScrollable(5000, 800);
      vi.spyOn(window, "scrollTo")
        .mockImplementationOnce(() => addBorrowedCard())
        .mockImplementation(() => {});

      const result = await runScrape(40, 500);

      expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID]);
      expect(result.complete).toBe(false);
    });

    it("stamps a card that only rendered during pagination (fiber data requested again afterwards)", async () => {
      // F3: the late card has NO id source but the fiber stamp, so it can only
      // be read if fiber data is requested after the scroll that rendered it.
      const LATE_ID = "210439468000202";
      cleanupBridge = installFiberBridgeMock([
        { bookId: GOOD_ID, title: "好書" },
        { bookId: LATE_ID, title: "後來的書" },
      ]);
      cleanupTotal = installListTotalPublisher("cards");
      document.body.innerHTML = GOOD_CARD;
      setScrollable(5000, 800);
      vi.spyOn(window, "scrollTo")
        .mockImplementationOnce(() => {
          const div = document.createElement("div");
          div.className = "library-item";
          div.innerHTML = `<div class="info"><div class="title" title="後來的書">後來的書</div></div>`;
          document.body.appendChild(div);
        })
        .mockImplementation(() => {});

      const result = await runScrape(40, 500);

      expect(result.books.map((b) => b.bookId)).toEqual([GOOD_ID, LATE_ID]);
      expect(result.complete).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
