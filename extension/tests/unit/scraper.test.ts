import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    // Need to advance in steps so the setInterval fires
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    const result = await promise;
    expect(result).toEqual([]);
  });

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
      expect(book.isArchived).toBe(1);
    }
    // All books should have valid bookIds
    for (const book of result) {
      expect(book.bookId).toBeTruthy();
    }
  });
});
