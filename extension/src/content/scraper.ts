/**
 * Book scraping logic for Readmoo library page.
 * `.library-item` divs require a hover event to reveal `.openbook` links.
 */

import { BoolFlag } from "../api/client";
import {
  paginateLibrary,
  type ScrapeBooksOptions,
  type ScrapeProgressCallback,
} from "./scraper-pagination";

export interface ScrapedBook {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  readmooUrl: string;
  category: string;
  isArchived?: BoolFlag;
}

const HOVER_SETTLE_MS = 120;
const READMOO_BOOK_BASE = "https://readmoo.com/book/";
const ATTR_BOOK_ID = "data-moo-book-id";
const ATTR_COVER = "data-moo-cover-url";
const ATTR_AUTHOR = "data-moo-author";
const ATTR_CATEGORY = "data-moo-category";

// Re-export Wave G pagination types so callers can keep `../content/scraper` as the single entry point.
export type { ScrapeProgressCallback, ScrapeBooksOptions };
export { formatScrapeProgress } from "./scraper-pagination";

/** Dispatch synthetic hover events so Readmoo renders the `.openbook` overlay. */
function triggerHover(element: HTMLElement): void {
  const options: MouseEventInit = { bubbles: true, cancelable: true };
  element.dispatchEvent(new MouseEvent("mouseenter", options));
  element.dispatchEvent(new MouseEvent("mouseover", options));
}

/** Wait for `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract book ID (last path segment) from `.openbook a.reader-link` href. */
function extractBookIdFromHref(href: string): string | null {
  try {
    const url = new URL(href);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

/** Extract fallback book ID from `.privacy` element (id="privacy-{id}"). */
function extractFallbackId(item: Element): string | null {
  const privacy = item.querySelector<HTMLElement>(".privacy[id^='privacy-']");
  if (!privacy) return null;
  const match = privacy.id.match(/^privacy-(\d+)$/);
  return match ? match[1] : null;
}

/** Extract title from `.info .title[title]`. */
function extractTitle(item: Element): string | null {
  const titleEl = item.querySelector<HTMLElement>(".info .title[title]");
  return titleEl?.getAttribute("title")?.trim() || null;
}

const PLACEHOLDER_COVER = "openbook.png";

function extractCoverUrl(item: Element): string {
  const img = item.querySelector<HTMLImageElement>(".cover-img[src]");
  const src = img?.src ?? "";
  // Return empty string for placeholder so mergeBooks preserves real cover URL.
  return src.endsWith(PLACEHOLDER_COVER) ? "" : src;
}

/** Inject the fiber-bridge script into the page's main world. */
function injectFiberBridge(): void {
  if (document.documentElement.hasAttribute("data-moo-fiber-bridge")) return;
  document.documentElement.setAttribute("data-moo-fiber-bridge", "1");
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("fiber-bridge.js");
  script.onload = () => script.remove();
  document.documentElement.appendChild(script);
}

/** Request the fiber bridge to stamp `data-moo-book-id` on all `.library-item` elements. */
async function requestFiberData(): Promise<void> {
  injectFiberBridge();
  await wait(100); // ensure the injected script has loaded

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 2000);
    document.addEventListener(
      "moo-fiber-data",
      () => { clearTimeout(timeout); resolve(); },
      { once: true },
    );
    document.dispatchEvent(new CustomEvent("moo-request-fiber-data"));
  });
}

/** Read book ID from `data-moo-book-id` attribute stamped by the fiber bridge. */
function extractBookIdFromFiber(item: Element): string | null {
  return item.getAttribute(ATTR_BOOK_ID);
}

/** Check if the book is borrowed (借入) — not part of the user's own bookshelf. */
function isBorrowed(item: Element): boolean {
  return item.querySelector('[type="borrowed"]') !== null;
}

async function scrapeItem(item: Element): Promise<ScrapedBook | null> {
  if (isBorrowed(item)) return null;

  const title = extractTitle(item);
  if (!title) return null;

  // Primary: read metadata from fiber bridge data attributes
  let bookId = extractBookIdFromFiber(item);
  let coverUrl = item.getAttribute(ATTR_COVER) ?? "";
  const author = item.getAttribute(ATTR_AUTHOR) ?? "";
  const category = item.getAttribute(ATTR_CATEGORY) ?? "";

  // Fallback: hover + DOM extraction when fiber tree is unavailable
  if (!bookId) {
    if (!coverUrl) coverUrl = extractCoverUrl(item);

    if (item instanceof HTMLElement) {
      triggerHover(item);
    }
    await wait(HOVER_SETTLE_MS);

    const openbookLink = item.querySelector<HTMLAnchorElement>(
      ".openbook a.reader-link[href]",
    );
    if (openbookLink) {
      bookId = extractBookIdFromHref(openbookLink.href);
    }

    if (!bookId) {
      bookId = extractFallbackId(item);
    }
  }

  if (!bookId) return null;

  // If fiber didn't provide cover, fall back to DOM
  if (!coverUrl) coverUrl = extractCoverUrl(item);

  return {
    bookId,
    title,
    author,
    coverUrl,
    readmooUrl: `${READMOO_BOOK_BASE}${bookId}`,
    category,
    isArchived: BoolFlag.FALSE,
  };
}

/** Scrape user email from the Readmoo profile panel (#/me page). */
export function scrapeUserEmail(): string | null {
  const panel = document.querySelector(".me-panel");
  if (!panel) return null;

  // Email is a leaf div (no child elements) containing "@".
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

/** Scrape display name from the Readmoo profile panel (#/me page). */
export function scrapeDisplayName(): string | null {
  const panel = document.querySelector(".me-panel");
  if (!panel) return null;
  const nameEl = panel.querySelector<HTMLElement>(
    "div[style*='font-size: 16px']",
  );
  return nameEl?.textContent?.trim() || null;
}

/** Scrape all books from the current Readmoo library page. */
export async function scrapeBooks(
  opts?: ScrapeBooksOptions,
): Promise<ScrapedBook[]> {
  const originalScrollY = window.scrollY;
  try {
    await requestFiberData();
    await paginateLibrary(opts?.onProgress);
    const items = document.querySelectorAll(".library-item");
    const books: ScrapedBook[] = [];
    for (const item of items) {
      const book = await scrapeItem(item);
      if (book) books.push(book);
    }
    return books;
  } finally {
    window.scrollTo(0, originalScrollY);
  }
}

// Re-export archive scraping so existing imports continue to work
export { scrapeArchivedBooks } from "./scraper-archive";
