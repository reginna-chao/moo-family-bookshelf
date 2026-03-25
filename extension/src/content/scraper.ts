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
async function scrapeItem(item: Element): Promise<ScrapedBook | null> {
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

  // Email is the element with font-size 14px and gray color under the name
  const candidates = panel.querySelectorAll<HTMLElement>("div[style]");
  for (const el of candidates) {
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
