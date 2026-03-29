import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag } from "@/api/client";

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

describe("scrapeBooks", () => {
  let scrapeBooks: () => Promise<import("@/content/scraper").ScrapedBook[]>;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.body.innerHTML = "";
    vi.resetModules();
    const mod = await import("@/content/scraper");
    scrapeBooks = mod.scrapeBooks;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("returns empty array when no .library-item elements exist", async () => {
    const result = await scrapeBooks();
    expect(result).toEqual([]);
  });

  it("scrapes a library item with privacy fallback ID", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Test Book">Test Book</div></div>
        <img class="cover-img" src="https://example.com/cover.jpg" />
        <div class="privacy" id="privacy-99999"></div>
      </div>
    `;

    const promise = scrapeBooks();

    // Advance past the hover wait (120ms per item)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(120);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("99999");
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
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(120);
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
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(120);
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
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(120);
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
          <a class="reader-link" href="https://readmoo.com/api/reader/123456">Open</a>
        </div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(120);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].bookId).toBe("123456");
  });

  it("marks all scraped books with isArchived: 0", async () => {
    document.body.innerHTML = `
      <div class="library-item">
        <div class="info"><div class="title" title="Active Book">Active Book</div></div>
        <img class="cover-img" src="" />
        <div class="privacy" id="privacy-33333"></div>
      </div>
    `;

    const promise = scrapeBooks();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(120);
    }

    const result = await promise;
    expect(result).toHaveLength(1);
    expect(result[0].isArchived).toBe(BoolFlag.FALSE);
  });
});

describe("scrapeArchivedBooks", () => {
  let scrapeArchivedBooks: () => Promise<import("@/content/scraper").ScrapedBook[]>;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Reset DOM
    document.body.innerHTML = "";
    // Fresh import each time to avoid stale module state
    vi.resetModules();
    const mod = await import("@/content/scraper");
    scrapeArchivedBooks = mod.scrapeArchivedBooks;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("returns empty array when filter button is not found in DOM", async () => {
    // No .desktop-top-nav-btn elements in DOM at all
    const result = await scrapeArchivedBooks();
    expect(result).toEqual([]);
  });

  it("returns empty array when nav buttons exist but none contain i.mo-filter", async () => {
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-search"></i></button>
      <button class="desktop-top-nav-btn"><i class="mo-sort"></i></button>
    `;

    const result = await scrapeArchivedBooks();
    expect(result).toEqual([]);
  });

  it("returns empty array when filter modal does not appear (timeout)", async () => {
    // Add filter button but never create the modal
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-filter"></i></button>
    `;

    const promise = scrapeArchivedBooks();

    // Advance past the 3000ms waitForElement timeout (polls every 200ms)
    // Plus the finally block: 2nd waitForElement (3000ms) + wait(2000ms)
    // Total needed: ~8000ms — advance in steps so setInterval fires
    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("returns empty array when archive option element not found", async () => {
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-filter"></i></button>
    `;

    const promise = scrapeArchivedBooks();

    // Wait for filter button click, then create modal without archive option
    await vi.advanceTimersByTimeAsync(200);
    const modal = document.createElement("div");
    modal.className = "filter-modal modal show";
    modal.innerHTML = `
      <div class="modal-footer">
        <button class="btn-primary">確定</button>
      </div>
    `;
    document.body.appendChild(modal);

    // Advance enough for: waitForElement poll + early return + finally block cleanup
    // Finally block opens filter dialog again, waits, etc.
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const result = await promise;
    expect(result).toEqual([]);
  }, 15000);

  it("returns scraped books marked with isArchived=1 on success", async () => {
    // Set up full DOM: filter button, library items
    document.body.innerHTML = `
      <button class="desktop-top-nav-btn"><i class="mo-filter"></i></button>
      <div class="library-item">
        <div class="info"><div class="title" title="Book One">Book One</div></div>
        <img class="cover-img" src="https://example.com/cover1.jpg" />
        <div class="privacy" id="privacy-12345"></div>
      </div>
    `;

    const promise = scrapeArchivedBooks();

    // After the filter button click, the code waits for .filter-modal.modal.show
    // Simulate the modal appearing after a short delay
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

    // Let waitForElement find the modal
    await vi.advanceTimersByTimeAsync(200);

    // The code clicks archive option and confirm button, then waits for library reload.
    // Simulate library count change by adding another item
    await vi.advanceTimersByTimeAsync(300);
    const newItem = document.createElement("div");
    newItem.className = "library-item";
    newItem.innerHTML = `
      <div class="info"><div class="title" title="Archived Book">Archived Book</div></div>
      <img class="cover-img" src="https://example.com/cover2.jpg" />
      <div class="privacy" id="privacy-67890"></div>
    `;
    document.body.appendChild(newItem);

    // Advance through the reload polling (5000ms max) + settle time (500ms)
    // + scrapeItem hover wait (120ms per item) + finally block cleanup
    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const result = await promise;

    // Should have books marked as archived
    expect(result.length).toBeGreaterThan(0);
    for (const book of result) {
      expect(book.isArchived).toBe(BoolFlag.TRUE);
    }
    // All books should have valid bookIds
    for (const book of result) {
      expect(book.bookId).toBeTruthy();
    }
  });
});
