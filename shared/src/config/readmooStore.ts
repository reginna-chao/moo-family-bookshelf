/** Single source of truth for the Readmoo store (購買頁) host, book-page URL and selectors; the web-app
 *  hosts stay in `./readmoo.ts`. See docs/architecture.md → 2.1 Content Script. */

import { isRealBookId } from "../api/bookId";

export const READMOO_HOST_STORE = "readmoo.com";
export const READMOO_STORE_BOOK_PATH_PREFIX = "/book/";

/** Base of every store book-page URL; the scraper's `readmooUrl` is built from it. */
export const READMOO_STORE_BOOK_URL_BASE = `https://${READMOO_HOST_STORE}${READMOO_STORE_BOOK_PATH_PREFIX}`;

/** Optional host-permission match patterns for the store-page chip. Kept apart from
 *  `READMOO_MATCH_PATTERNS`, which verify-build requires to equal `host_permissions` exactly. */
export const READMOO_STORE_MATCH_PATTERNS: readonly string[] = [
  `https://${READMOO_HOST_STORE}/book/*`,
];

/** Store book-page DOM selectors. Not covered by verify-selectors; pinned by test fixtures. */
export const READMOO_STORE_SELECTORS = {
  bookTitle: "h1.book-detail-title",
  bookMetaBox: ".book-meta-box",
} as const;

/**
 * The book id of a store book page, from `location.pathname` only: exactly
 * `/book/{id}` (one trailing `/` allowed) with a real Readmoo id. Anything
 * else — `/book/{id}.html`, a deeper path, a non-numeric id — is `null`.
 */
export function storeBookIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(READMOO_STORE_BOOK_PATH_PREFIX)) return null;
  let rest = pathname.slice(READMOO_STORE_BOOK_PATH_PREFIX.length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  return isRealBookId(rest) ? rest : null;
}
