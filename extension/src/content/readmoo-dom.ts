/** Shared DOM primitives for every Readmoo-scraping consumer (lending, scraper, sync entry points),
 *  depending on none of them. See docs/architecture.md → Content Script 的擷取與注入. */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";

const ATTR_BOOK_ID = "data-moo-book-id";

/** Error thrown throughout the Readmoo lending automation. */
export class ReadmooLendError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReadmooLendError";
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}

/**
 * Find the `.library-item` element matching the given bookId.
 *
 * Relies on the fiber-bridge having stamped `data-moo-book-id` on
 * library-item nodes. If the book is not on the currently-rendered
 * page (lazy loading / pagination), returns null.
 */
export function findBookCardInLibrary(bookId: string): HTMLElement | null {
  const selector = `${READMOO_SELECTORS.libraryItem}[${ATTR_BOOK_ID}="${cssEscape(bookId)}"]`;
  return document.querySelector<HTMLElement>(selector);
}

/** Labels that already warned: de-duplicated PER LABEL, not per element (25+ cards would bury real
 *  errors); one line per label per sync answers "is this degraded path still being hit?". */
const warnedLabels = new Set<string>();

/**
 * Reset the warn-once de-duplication state so every `label` can fire again.
 *
 * Called by each scrape ENTRY POINT at the start of a run (`sync/syncBooks.ts`
 * for auto/manual sync, `dialog/useAutoSetup.ts` for onboarding auto-setup) so a
 * still-hit degraded path re-surfaces on every run instead of only once per page
 * load — the library page is a SPA that can stay open for days. Tests also call
 * it to isolate warning assertions.
 *
 * Side effect: mutates module-level warning state.
 */
export function resetScrapeWarnings(): void {
  warnedLabels.clear();
}

/**
 * Emit `message` via `console.warn` at most once per `label` per scrape run.
 *
 * Shared by every scrape-time degradation signal (legacy selector fallbacks,
 * rejected book ids) so they all honour the same de-duplication window and the
 * same `resetScrapeWarnings` reset point.
 *
 * Side effect: writes to the console and mutates module-level warning state.
 */
export function warnOnce(label: string, message: string): void {
  if (warnedLabels.has(label)) return;
  warnedLabels.add(label);
  console.warn(message);
}

/**
 * Query `primary` first and fall back to `legacy` when it finds nothing.
 *
 * Readmoo's new bookshelf host (`next.readmoo.com`) renamed/moved several
 * library-item nodes. We must keep supporting the legacy host, so every moved
 * selector goes through here. Hitting the legacy branch emits a single
 * `console.warn` tagged with `label`, making it obvious which selector still
 * needs the fallback — and therefore when it becomes safe to delete.
 *
 * Side effect: writes to the console (de-duplicated per label, see above).
 */
export function queryWithLegacyFallback<T extends Element>(
  root: ParentNode,
  primary: string,
  legacy: string,
  label: string,
): T | null {
  const found = root.querySelector<T>(primary);
  if (found) return found;

  const legacyFound = root.querySelector<T>(legacy);
  if (!legacyFound) return null;

  warnOnce(
    label,
    `[moo] legacy selector fallback hit for "${label}": "${primary}" not found, used "${legacy}"`,
  );
  return legacyFound;
}

/**
 * Wait for an element matching `selector` to appear in the DOM.
 * Used by openBookDetailModal and the lending search flow.
 */
export function waitForElement<T extends HTMLElement>(
  selector: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<T>(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const found = document.querySelector<T>(selector);
      if (found) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(
        new ReadmooLendError("ELEMENT_TIMEOUT", `等待元素逾時：${selector}`),
      );
    }, timeoutMs);
  });
}
