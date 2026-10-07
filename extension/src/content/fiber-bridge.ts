/** Fiber bridge — runs in the page's MAIN WORLD to read React fiber props the isolated content script
 *  cannot, stamping them onto the shared DOM. See docs/architecture.md → Content Script 的擷取與注入. */

import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";

const ATTR_BOOK_ID = "data-moo-book-id";
const ATTR_COVER = "data-moo-cover-url";
const ATTR_AUTHOR = "data-moo-author";
const ATTR_CATEGORY = "data-moo-category";
const MAX_CATEGORY_LEN = 50;

/** For each `.library-item`, walk a child's React fiber up to `libraryItem` and stamp `book.id`, the
 *  cover (medium, else small), author and category (`main_subject`) as `data-moo-*` attributes. */
function stampBookData(): void {
  const items = document.querySelectorAll(READMOO_SELECTORS.libraryItem);

  for (const item of items) {
    if (item.hasAttribute(ATTR_BOOK_ID)) continue;

    const els = item.querySelectorAll("*");
    for (const el of els) {
      const fiberKey = Object.keys(el).find((k) =>
        k.startsWith("__reactFiber"),
      );
      if (!fiberKey) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fiber = (el as any)[fiberKey];
      while (fiber) {
        const libraryItem = fiber.memoizedProps?.libraryItem;
        if (libraryItem?.book?.id) {
          const book = libraryItem.book;
          const attrs = book.attributes;

          item.setAttribute(ATTR_BOOK_ID, String(book.id));

          const coverHref =
            attrs?.cover?.medium?.href ?? attrs?.cover?.small?.href;
          if (coverHref) item.setAttribute(ATTR_COVER, coverHref);

          if (attrs?.author) item.setAttribute(ATTR_AUTHOR, attrs.author);

          if (attrs?.main_subject) {
            // Readmoo uses "\\" as separator (e.g. "奇幻\\科幻小說");
            // normalise to single backslash to match their book detail page.
            const category = attrs.main_subject
              .replace(/\\\\/g, "\\")
              .slice(0, MAX_CATEGORY_LEN);
            item.setAttribute(ATTR_CATEGORY, category);
          }

          break;
        }
        fiber = fiber.return;
      }

      if (item.hasAttribute(ATTR_BOOK_ID)) break;
    }
  }
}

/** On `<html>`: the grid's item count for the current filter (`filteredItemList.length`), removed when
 *  unreadable so no stale value survives. Must equal `ATTR_LIST_TOTAL` in `fiber-data.ts`. */
const ATTR_LIST_TOTAL = "data-moo-list-total";
/** Parent row of the library cards — the host lookup start when no card renders. */
const LIBRARY_ROW_SELECTOR = ".books .row";
/** Upper bound on `return` hops (the host sits ~8 above a card, ~4 above the row). */
const MAX_HOST_DEPTH = 40;

/** The React fiber attached to `el` itself, if any. */
function ownFiber(el: Element): unknown {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
  return key ? (el as unknown as Record<string, unknown>)[key] : undefined;
}

/** `el`'s own fiber, else the first descendant's (a card may carry none itself). */
function fiberFrom(el: Element): unknown {
  const own = ownFiber(el);
  if (own) return own;
  for (const child of el.querySelectorAll("*")) {
    const fiber = ownFiber(child);
    if (fiber) return fiber;
  }
  return undefined;
}

/** `filteredItemList.length` of the nearest ancestor that holds it, else null. */
function filteredItemCount(start: Element): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fiber: any = fiberFrom(start);
  for (let depth = 0; fiber && depth < MAX_HOST_DEPTH; depth++) {
    const list = fiber.memoizedProps?.filteredItemList;
    if (Array.isArray(list)) return list.length;
    fiber = fiber.return;
  }
  return null;
}

/** Write the current list total onto `<html>`, or remove it when unreadable. */
function publishListTotal(): void {
  const root = document.documentElement;
  let total: number | null = null;
  try {
    const start =
      document.querySelector(READMOO_SELECTORS.libraryItem) ??
      document.querySelector(LIBRARY_ROW_SELECTOR);
    total = start ? filteredItemCount(start) : null;
  } catch {
    total = null;
  }
  if (total !== null && Number.isSafeInteger(total) && total >= 0) {
    root.setAttribute(ATTR_LIST_TOTAL, String(total));
  } else {
    root.removeAttribute(ATTR_LIST_TOTAL);
  }
}

// Listen for requests from the content script. Never throw into the page.
document.addEventListener("moo-request-fiber-data", () => {
  try {
    stampBookData();
  } catch {
    // A card the bridge cannot read falls back to the hover path.
  }
  publishListTotal();
  document.dispatchEvent(new CustomEvent("moo-fiber-data"));
});
