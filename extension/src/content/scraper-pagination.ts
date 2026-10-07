/** Pagination loop for the library page (Wave G): scroll the window-level infinite scroll (~200 items per
 *  batch) until no new cards appear, with progress reporting and a hard cap as a safety valve. */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";

const SCROLL_HARD_CAP = 100;
const PAGE_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 500;
const NO_ACTIVITY_CUTOFF_MS = 5500;

export type ScrapeProgressCallback = (page: number, count: number) => void;

export interface ScrapeBooksOptions {
  onProgress?: ScrapeProgressCallback;
}

/** Single source of truth for the scrape progress message (Wave G Q-A). */
export function formatScrapeProgress(page: number, count: number): string {
  return `正在讀取第 ${page} 頁，已收集 ${count} 本…`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countLibraryItems(): number {
  return document.querySelectorAll(READMOO_SELECTORS.libraryItem).length;
}

/** Poll the `.library-item` count until it exceeds `baseline`, exiting early on DOM inactivity; a moving
 *  scrollHeight (loader / spacer) counts as activity. `timeoutMs` is the hard ceiling. */
async function waitForItemCountIncrease(
  baseline: number,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const start = Date.now();
  let lastScrollHeight = document.documentElement.scrollHeight;
  let lastActivityAt = Date.now();

  while (Date.now() - start < timeoutMs) {
    await wait(intervalMs);
    if (countLibraryItems() > baseline) return true;

    const currentScrollHeight = document.documentElement.scrollHeight;
    if (currentScrollHeight !== lastScrollHeight) {
      lastScrollHeight = currentScrollHeight;
      lastActivityAt = Date.now();
    }

    if (Date.now() - lastActivityAt >= NO_ACTIVITY_CUTOFF_MS) return false;
  }
  return false;
}

/**
 * Scroll the Readmoo library page to load more books in batches.
 * Loop exits on (a) no growth after a scroll, (b) hard cap reached, or
 * (c) page not scrollable (jsdom test envs).
 *
 * Returns false for (b), true otherwise — i.e. only "did not hit the hard
 * cap". True does NOT mean every book was loaded: (a) also happens when the
 * next page is merely slow. Completeness is confirmed elsewhere, against
 * Readmoo's own item count (`isLibraryScrapeComplete` in `scrapeResult.ts`).
 */
export async function paginateLibrary(
  onProgress?: ScrapeProgressCallback,
): Promise<boolean> {
  // No pagination possible when the page isn't scrollable.
  // Also covers jsdom test envs where layout dimensions are 0.
  if (
    document.documentElement.scrollHeight <=
    document.documentElement.clientHeight
  ) {
    return true;
  }

  let page = 1;
  while (page <= SCROLL_HARD_CAP) {
    const count = countLibraryItems();
    window.scrollTo(0, document.documentElement.scrollHeight);
    const grew = await waitForItemCountIncrease(
      count,
      PAGE_TIMEOUT_MS,
      POLL_INTERVAL_MS,
    );
    if (!grew) return true;
    onProgress?.(page, countLibraryItems());
    page++;
  }
  console.warn("[Wave G] Reached hard cap of 100 pages, stopping scrape");
  return false;
}
