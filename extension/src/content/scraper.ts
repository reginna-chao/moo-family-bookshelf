/**
 * Book scraping logic for Readmoo library page.
 * `.library-item` divs require a hover event to reveal the `.openbook-overlay`
 * action layer (named `.openbook` on the legacy host).
 *
 * Works on both `next.readmoo.com` and `read.readmoo.com`; selectors that moved
 * between the two go through `queryWithLegacyFallback`.
 */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";
import { BoolFlag } from "../api/client";
import { requestFiberData } from "./fiber-data";
import { queryWithLegacyFallback } from "./readmoo-dom";
import {
  paginateLibrary,
  type ScrapeBooksOptions,
  type ScrapeProgressCallback,
} from "./scraper-pagination";
import {
  bookIdFromFiber,
  bookIdFromHref,
  bookIdFromPrivacy,
} from "./scraper-ids";
import { isLibraryScrapeComplete, type ScrapeResult } from "./scrapeResult";

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
const ATTR_COVER = "data-moo-cover-url";
const ATTR_AUTHOR = "data-moo-author";
const ATTR_CATEGORY = "data-moo-category";

// Re-export Wave G pagination types so callers can keep `../content/scraper` as the single entry point.
export type { ScrapeProgressCallback, ScrapeBooksOptions, ScrapeResult };
export { formatScrapeProgress } from "./scraper-pagination";

/**
 * One card's outcome: a scraped book, `"borrowed"` (a 借入 card — not the
 * user's own book, ignored), or `null` (an own book that could not be read,
 * which makes the scrape incomplete).
 */
type ItemOutcome = ScrapedBook | "borrowed" | null;

/** Dispatch synthetic hover events so Readmoo renders the `.openbook-overlay` layer. */
function triggerHover(element: HTMLElement): void {
  const options: MouseEventInit = { bubbles: true, cancelable: true };
  element.dispatchEvent(new MouseEvent("mouseenter", options));
  element.dispatchEvent(new MouseEvent("mouseover", options));
}

/** Wait for `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract title from `.info .title[title]`. */
function extractTitle(item: Element): string | null {
  const titleEl = item.querySelector<HTMLElement>(READMOO_SELECTORS.title);
  return titleEl?.getAttribute("title")?.trim() || null;
}

const PLACEHOLDER_COVER = "openbook.png";

function extractCoverUrl(item: Element): string {
  const img = item.querySelector<HTMLImageElement>(READMOO_SELECTORS.coverImg);
  const src = img?.src ?? "";
  // Return empty string for placeholder so mergeBooks preserves real cover URL.
  return src.endsWith(PLACEHOLDER_COVER) ? "" : src;
}

/** Check if the book is borrowed (借入) — not part of the user's own bookshelf. */
function isBorrowed(item: Element): boolean {
  return item.querySelector(READMOO_SELECTORS.borrowedBadge) !== null;
}

/**
 * Primary id source is the fiber bridge; when it holds none, hover the card and
 * fall back to the reader-link href, then `.privacy`. A source holding a
 * non-real id ends the search with null (skip the book) — see `BookIdLookup`.
 */
async function resolveBookId(item: Element): Promise<string | null> {
  const fiberId = bookIdFromFiber(item);
  if (fiberId !== undefined) return fiberId;

  if (item instanceof HTMLElement) triggerHover(item);
  await wait(HOVER_SETTLE_MS);

  const readerLink = queryWithLegacyFallback<HTMLAnchorElement>(
    item,
    READMOO_SELECTORS.readerLink,
    READMOO_SELECTORS.readerLinkLegacy,
    "scraper:reader-link",
  );
  const hrefId = readerLink ? bookIdFromHref(readerLink.href) : undefined;
  if (hrefId !== undefined) return hrefId;
  return bookIdFromPrivacy(item);
}

async function scrapeItem(item: Element): Promise<ItemOutcome> {
  if (isBorrowed(item)) return "borrowed";

  const title = extractTitle(item);
  if (!title) return null;

  // Fiber bridge data attributes first; DOM cover read before any hover.
  let coverUrl = item.getAttribute(ATTR_COVER) || extractCoverUrl(item);
  const author = item.getAttribute(ATTR_AUTHOR) ?? "";
  const category = item.getAttribute(ATTR_CATEGORY) ?? "";

  const bookId = await resolveBookId(item);
  if (!bookId) return null;

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
  const panel = document.querySelector(READMOO_SELECTORS.mePanel);
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
  const panel = document.querySelector(READMOO_SELECTORS.mePanel);
  if (!panel) return null;
  const nameEl = panel.querySelector<HTMLElement>(
    "div[style*='font-size: 16px']",
  );
  return nameEl?.textContent?.trim() || null;
}

/**
 * Scrape all books from the current Readmoo library page, reporting whether
 * the scrape is complete (no own book skipped, pagination not capped).
 */
export async function scrapeLibrary(
  opts?: ScrapeBooksOptions,
): Promise<ScrapeResult> {
  const originalScrollY = window.scrollY;
  try {
    await requestFiberData();
    const paginationComplete = await paginateLibrary(opts?.onProgress);
    const items = document.querySelectorAll(READMOO_SELECTORS.libraryItem);
    const books: ScrapedBook[] = [];
    let skippedCount = 0;
    for (const item of items) {
      const outcome = await scrapeItem(item);
      if (outcome === null) skippedCount++;
      else if (outcome !== "borrowed") books.push(outcome);
    }
    const complete = isLibraryScrapeComplete({
      skippedCount,
      paginationComplete,
    });
    return { books, complete };
  } finally {
    window.scrollTo(0, originalScrollY);
  }
}

/** Scrape all books from the current Readmoo library page (books only). */
export async function scrapeBooks(
  opts?: ScrapeBooksOptions,
): Promise<ScrapedBook[]> {
  return (await scrapeLibrary(opts)).books;
}

// Re-export archive scraping so existing imports continue to work
export { scrapeArchivedBooks } from "./scraper-archive";
