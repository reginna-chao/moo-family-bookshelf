/**
 * Archive scraping logic for Readmoo library page.
 *
 * Manipulates Readmoo's filter dialog to switch to the archived books
 * view, scrapes the results, then restores the normal library view.
 */

import { BoolFlag } from "../api/client";
import { scrapeBooks, type ScrapedBook, type ScrapeBooksOptions } from "./scraper";

/** Wait for `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for an element matching the selector, returning null on timeout.
 */
function waitForElement(
  selector: string,
  timeoutMs: number,
): Promise<Element | null> {
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
export async function scrapeArchivedBooks(
  opts?: ScrapeBooksOptions,
): Promise<ScrapedBook[]> {
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
    const books = await scrapeBooks(opts);
    return books.map((b) => ({ ...b, isArchived: BoolFlag.TRUE }));
  } catch {
    return [];
  } finally {
    // Step 7: Clear filter — must restore normal library view
    try {
      const clearBtn = findFilterButton();
      if (clearBtn) {
        clearBtn.click();
        const clearModal = await waitForElement(
          ".filter-modal.modal.show",
          3000,
        );
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
