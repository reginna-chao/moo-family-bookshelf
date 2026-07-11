/**
 * Shared DOM primitives for the Readmoo lending flow.
 *
 * Extracted so `readmoo-lend.ts` and `readmoo-search.ts` can both depend on
 * these low-level helpers without importing each other (which previously formed
 * a module cycle). This module has no dependency on either.
 */

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
  const selector = `.library-item[${ATTR_BOOK_ID}="${cssEscape(bookId)}"]`;
  return document.querySelector<HTMLElement>(selector);
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
      reject(new ReadmooLendError("ELEMENT_TIMEOUT", `等待元素逾時：${selector}`));
    }, timeoutMs);
  });
}
