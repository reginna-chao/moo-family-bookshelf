/**
 * Pagination loop for the Readmoo library page (Wave G).
 *
 * Readmoo uses window-level infinite scroll: scrolling to the bottom of
 * the page triggers the next batch (~200 items). This module drives that
 * loop until no more books are loaded, with progress reporting and a
 * hard cap as a safety valve.
 */

const SCROLL_HARD_CAP = 100;
const PAGE_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 500;

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
  return document.querySelectorAll(".library-item").length;
}

/**
 * Poll `.library-item` count until it exceeds `baseline`, or `timeoutMs` elapses.
 * Returns true if new items appeared, false if timed out (treated as "no more pages").
 */
async function waitForItemCountIncrease(
  baseline: number,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await wait(intervalMs);
    if (countLibraryItems() > baseline) return true;
  }
  return false;
}

/**
 * Scroll the Readmoo library page to load all available books in batches.
 * Loop exits on (a) no growth after a scroll (no more pages), (b) hard
 * cap reached, or (c) page not scrollable (jsdom test envs).
 */
export async function paginateLibrary(
  onProgress?: ScrapeProgressCallback,
): Promise<void> {
  // No pagination possible when the page isn't scrollable.
  // Also covers jsdom test envs where layout dimensions are 0.
  if (
    document.documentElement.scrollHeight <= document.documentElement.clientHeight
  ) {
    return;
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
    if (!grew) return;
    onProgress?.(page, countLibraryItems());
    page++;
  }
  console.warn("[Wave G] Reached hard cap of 100 pages, stopping scrape");
}
