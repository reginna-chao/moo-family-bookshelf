/**
 * Fiber bridge script — runs in the page's MAIN WORLD.
 *
 * The Content Script runs in Chrome's isolated world and cannot see
 * React fiber properties (`__reactFiber*`) on DOM elements. This script
 * is injected as a `<script>` tag so it shares the page's JS context
 * and can read fiber internals.
 *
 * Communication uses the shared DOM: this script writes `data-moo-book-id`
 * attributes directly onto `.library-item` elements so the Content Script
 * can read them without CustomEvents or cache matching.
 */

const ATTR_BOOK_ID = "data-moo-book-id";
const ATTR_COVER = "data-moo-cover-url";
const ATTR_AUTHOR = "data-moo-author";
const ATTR_CATEGORY = "data-moo-category";
const MAX_CATEGORY_LEN = 50;

/**
 * For each `.library-item`, find any child element with a React fiber,
 * walk up the fiber tree to find `libraryItem`, and stamp book metadata
 * as data attributes on the library item element.
 *
 * Attributes stamped:
 * - `data-moo-book-id`   — real bookId from `libraryItem.book.id`
 * - `data-moo-cover-url` — medium cover from `book.attributes.cover`
 * - `data-moo-author`    — author from `book.attributes.author`
 */
function stampBookData(): void {
  const items = document.querySelectorAll(".library-item");

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

// Listen for requests from the content script
document.addEventListener("moo-request-fiber-data", () => {
  stampBookData();
  document.dispatchEvent(new CustomEvent("moo-fiber-data"));
});
