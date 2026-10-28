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
/** On `<html>`: every book id Readmoo holds for the account, comma-joined; removed when unreadable.
 *  Must equal `ATTR_LIBRARY_IDS` in `fiber-data.ts`. */
const ATTR_LIBRARY_IDS = "data-moo-library-ids";
/** Upper bound on `return` hops (the host sits ~8 above a card, ~4 above the row). */
const MAX_HOST_DEPTH = 40;
/** Host lists whose union is the account's whole library (lent-out books may sit only in the last). */
const LIBRARY_ID_LISTS = [
  "itemList",
  "archivedLibraryItems",
  "loanedLibraryItems",
] as const;

type HostProps = Record<string, unknown>;

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

/** `memoizedProps` of the nearest ancestor holding a `filteredItemList` array, else null. */
function findLibraryHostProps(start: Element): HostProps | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fiber: any = fiberFrom(start);
  for (let depth = 0; fiber && depth < MAX_HOST_DEPTH; depth++) {
    const props = fiber.memoizedProps;
    if (Array.isArray(props?.filteredItemList)) return props as HostProps;
    fiber = fiber.return;
  }
  return null;
}

/** The library host's props, looked up from a card or (no card rendered) the cards' row. */
function readLibraryHostProps(): HostProps | null {
  const start =
    document.querySelector(READMOO_SELECTORS.libraryItem) ??
    document.querySelector(READMOO_SELECTORS.libraryRow);
  return start ? findLibraryHostProps(start) : null;
}

/** Write the current list total onto `<html>`, or remove it when unreadable. */
function publishListTotal(host: HostProps | null): void {
  const root = document.documentElement;
  const list = host?.filteredItemList;
  const total = Array.isArray(list) ? list.length : null;
  if (total !== null && Number.isSafeInteger(total) && total >= 0) {
    root.setAttribute(ATTR_LIST_TOTAL, String(total));
  } else {
    root.removeAttribute(ATTR_LIST_TOTAL);
  }
}

/** Deduped `book.id`s across the host's library lists; null unless ALL of them are arrays. */
function libraryIdsOf(host: HostProps): string[] | null {
  const ids = new Set<string>();
  for (const name of LIBRARY_ID_LISTS) {
    const list = host[name];
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      const id = item?.book?.id;
      if (typeof id === "string" || typeof id === "number") ids.add(String(id));
    }
  }
  return [...ids];
}

/** Write the account's book ids onto `<html>` ("" = known empty), or remove them when unreadable. */
function publishLibraryIds(host: HostProps | null): void {
  const root = document.documentElement;
  try {
    const ids = host ? libraryIdsOf(host) : null;
    if (ids === null) root.removeAttribute(ATTR_LIBRARY_IDS);
    else root.setAttribute(ATTR_LIBRARY_IDS, ids.join(","));
  } catch {
    root.removeAttribute(ATTR_LIBRARY_IDS);
  }
}

/** Publish both host-derived attributes from ONE host lookup; never throws. */
function publishHostData(): void {
  let host: HostProps | null = null;
  try {
    host = readLibraryHostProps();
  } catch {
    host = null;
  }
  try {
    publishListTotal(host);
  } catch {
    document.documentElement.removeAttribute(ATTR_LIST_TOTAL);
  }
  publishLibraryIds(host);
}

// Listen for requests from the content script. Never throw into the page.
document.addEventListener("moo-request-fiber-data", () => {
  try {
    stampBookData();
  } catch {
    // A card the bridge cannot read falls back to the hover path.
  }
  publishHostData();
  document.dispatchEvent(new CustomEvent("moo-fiber-data"));
});
