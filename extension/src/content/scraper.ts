/**
 * Book scraping logic for Readmoo library page.
 *
 * Readmoo's library (read.readmoo.com/#/library) renders books as
 * `.library-item` divs. The real book-specific link inside `.openbook`
 * only appears in the DOM after a hover event is dispatched.
 */

export interface ScrapedBook {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  readmooUrl: string;
  isArchived?: 0 | 1;
}

const HOVER_SETTLE_MS = 120;
const READMOO_BOOK_BASE = "https://mooink.readmoo.com/book/";

/**
 * Dispatch synthetic hover events on an element so Readmoo's React
 * code renders the `.openbook` overlay into the DOM.
 */
function triggerHover(element: HTMLElement): void {
  const options: MouseEventInit = { bubbles: true, cancelable: true };
  element.dispatchEvent(new MouseEvent("mouseenter", options));
  element.dispatchEvent(new MouseEvent("mouseover", options));
}

/**
 * Wait for `ms` milliseconds. Used to give React time to render
 * the overlay after a synthetic hover.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the book ID from the `.openbook a.reader-link` href.
 * The href looks like `https://readmoo.com/api/reader/210439468000101`.
 * Returns the last path segment.
 */
function extractBookIdFromHref(href: string): string | null {
  try {
    const url = new URL(href);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Attempt to extract a fallback book ID from the `.privacy` element.
 * The element has id="privacy-{id}".
 */
function extractFallbackId(item: Element): string | null {
  const privacy = item.querySelector<HTMLElement>(".privacy[id^='privacy-']");
  if (!privacy) return null;

  const match = privacy.id.match(/^privacy-(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Extract the title from `.info .title[title]`.
 */
function extractTitle(item: Element): string | null {
  const titleEl = item.querySelector<HTMLElement>(".info .title[title]");
  return titleEl?.getAttribute("title")?.trim() || null;
}

/**
 * Extract the cover image URL from `.cover-img[src]`.
 */
function extractCoverUrl(item: Element): string {
  const img = item.querySelector<HTMLImageElement>(".cover-img[src]");
  return img?.src ?? "";
}

/**
 * Scrape a single library item. Returns null if essential data
 * (title) is missing.
 */
/**
 * Check if the book is borrowed (借入) — these belong to someone else
 * and should not be included in the user's personal bookshelf.
 */
function isBorrowed(item: Element): boolean {
  return item.querySelector('[type="borrowed"]') !== null;
}

async function scrapeItem(item: Element): Promise<ScrapedBook | null> {
  if (isBorrowed(item)) return null;

  const title = extractTitle(item);
  if (!title) return null;

  const coverUrl = extractCoverUrl(item);

  // Trigger hover to make .openbook link appear
  if (item instanceof HTMLElement) {
    triggerHover(item);
  }
  await wait(HOVER_SETTLE_MS);

  // Try to get book ID from .openbook link
  const openbookLink = item.querySelector<HTMLAnchorElement>(
    ".openbook a.reader-link[href]",
  );
  let bookId: string | null = null;

  if (openbookLink) {
    bookId = extractBookIdFromHref(openbookLink.href);
  }

  // Fallback: use privacy element ID
  if (!bookId) {
    bookId = extractFallbackId(item);
  }

  if (!bookId) return null;

  return {
    bookId,
    title,
    author: "",
    coverUrl,
    readmooUrl: `${READMOO_BOOK_BASE}${bookId}`,
    isArchived: 0,
  };
}

/**
 * Scrape user email from the Readmoo profile panel (#/me page).
 * The email sits inside `.me-panel` as a div with gray text below
 * the display name.
 */
export function scrapeUserEmail(): string | null {
  const panel = document.querySelector(".me-panel");
  if (!panel) return null;

  // Email is a leaf div (no child elements) containing "@".
  // Using childElementCount === 0 ensures we get the exact text node,
  // not a parent whose textContent concatenates children.
  const candidates = panel.querySelectorAll<HTMLElement>("div[style]");
  for (const el of candidates) {
    if (el.childElementCount > 0) continue;
    const text = el.textContent?.trim() ?? "";
    if (text.includes("@") && text.includes(".")) {
      return text;
    }
  }
  return null;
}

/**
 * Scrape display name from the Readmoo profile panel (#/me page).
 */
export function scrapeDisplayName(): string | null {
  const panel = document.querySelector(".me-panel");
  if (!panel) return null;

  const nameEl = panel.querySelector<HTMLElement>(
    "div[style*='font-size: 16px']",
  );
  return nameEl?.textContent?.trim() || null;
}

/**
 * Scrape all books from the current Readmoo library page.
 *
 * Iterates over every `.library-item`, triggers a hover to
 * reveal the book-specific link, then extracts metadata.
 */
export async function scrapeBooks(): Promise<ScrapedBook[]> {
  const items = document.querySelectorAll(".library-item");
  const books: ScrapedBook[] = [];

  for (const item of items) {
    const book = await scrapeItem(item);
    if (book) {
      books.push(book);
    }
  }

  return books;
}

/**
 * Poll for an element matching the selector, returning null on timeout.
 */
function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 200);
  });
}

/**
 * Find and click an element by selector. Returns true if successful.
 */
function clickElement(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) {
    el.click();
    return true;
  }
  return false;
}

/**
 * Find the filter button in the Readmoo nav bar.
 */
function findFilterButton(): HTMLElement | null {
  const btns = document.querySelectorAll<HTMLElement>(".desktop-top-nav-btn");
  for (const btn of btns) {
    if (btn.querySelector("i.mo-filter")) return btn;
  }
  return null;
}

/**
 * Scrape archived books by manipulating Readmoo's filter dialog.
 * Steps:
 * 1. Click the filter button in the nav bar
 * 2. Wait for filter dialog to appear
 * 3. Click "已封存書籍" option
 * 4. Click "確定" to apply filter
 * 5. Wait for library items to reload
 * 6. Scrape all visible books (these are archived)
 * 7. Clear filter: reopen dialog → click "清除篩選" → click "確定"
 *
 * MUST use try/finally to ensure filter is always cleared.
 * Returns empty array on failure (silent fallback).
 */
/**
 * Wait for the library to finish reloading after a filter change.
 * Readmoo clears `.library-item` elements, then re-renders new ones.
 * We wait for items to disappear (or count to change), then wait for
 * new items to appear and stabilize.
 */
async function waitForLibraryReload(timeoutMs: number): Promise<void> {
  const start = Date.now();

  // Phase 1: Wait for items to disappear or change (Readmoo clears the list)
  const initialCount = document.querySelectorAll(".library-item").length;
  while (Date.now() - start < timeoutMs) {
    await wait(300);
    const count = document.querySelectorAll(".library-item").length;
    if (count !== initialCount) break;
  }

  // Phase 2: Wait for new items to appear and stabilize
  //   (count stays the same for 2 consecutive checks = rendering done)
  let stableCount = -1;
  let stableChecks = 0;
  while (Date.now() - start < timeoutMs) {
    await wait(500);
    const count = document.querySelectorAll(".library-item").length;
    if (count > 0 && count === stableCount) {
      stableChecks++;
      if (stableChecks >= 2) break;
    } else {
      stableCount = count;
      stableChecks = 0;
    }
  }
}

export async function scrapeArchivedBooks(): Promise<ScrapedBook[]> {
  try {
    // Step 1: Find and click the filter button
    const filterBtn = findFilterButton();
    if (!filterBtn) return [];
    filterBtn.click();

    // Step 2: Wait for filter modal
    const modal = await waitForElement(".filter-modal.modal.show", 3000);
    if (!modal) return [];

    // Step 3: Click "已封存書籍" option
    if (!clickElement('[data-key="archive"][data-value="true"]')) return [];

    // Brief pause for React to process the selection
    await wait(300);

    // Step 4: Click "確定" button
    if (!clickElement(".filter-modal .modal-footer .btn-primary")) return [];

    // Step 5: Wait for filter modal to close and library to reload
    await waitForLibraryReload(10000);

    // Step 6: Scrape books and mark as archived
    const books = await scrapeBooks();
    return books.map((b) => ({ ...b, isArchived: 1 }));
  } catch {
    return [];
  } finally {
    // Step 7: Clear filter — must restore normal library view
    try {
      const clearBtn = findFilterButton();
      if (clearBtn) {
        clearBtn.click();
        const clearModal = await waitForElement(".filter-modal.modal.show", 3000);
        if (clearModal) {
          clickElement(".filter-modal .modal-footer .btn-outline-primary");
          await wait(300);
          clickElement(".filter-modal .modal-footer .btn-primary");
          await waitForLibraryReload(10000);
        } else {
          window.location.hash = "#/library";
          await wait(2000);
        }
      } else {
        window.location.hash = "#/library";
        await wait(2000);
      }
    } catch {
      window.location.hash = "#/library";
      await wait(2000);
    }
  }
}
