/**
 * Single source of truth for Readmoo web-app hosts, URLs and DOM selectors.
 *
 * Readmoo moved the bookshelf front-end to a new host + path prefix while
 * keeping the legacy one online:
 *   - next   → https://next.readmoo.com/read/#/library   (note the `/read` prefix)
 *   - legacy → https://read.readmoo.com/#/library
 *
 * Both must stay supported. Anything that hard-codes a Readmoo host, hash route
 * or library DOM selector should import from here instead.
 */

export const READMOO_HOST_NEXT = "next.readmoo.com";
export const READMOO_HOST_LEGACY = "read.readmoo.com";

/** All supported Readmoo web-app hosts, new site first. */
export const READMOO_HOSTS: readonly string[] = [
  READMOO_HOST_NEXT,
  READMOO_HOST_LEGACY,
];

/** Origins of every supported host, new site first. */
export const READMOO_ORIGINS: readonly string[] = READMOO_HOSTS.map(
  (host) => `https://${host}`,
);

/** Manifest V3 match patterns for every supported host, new site first. */
export const READMOO_MATCH_PATTERNS: readonly string[] = READMOO_HOSTS.map(
  (host) => `https://${host}/*`,
);

/** Hash route of the library (書櫃) page. */
export const LIBRARY_HASH = "#/library";
/** Hash route of the profile (個人資料) page. */
export const ME_HASH = "#/me";

/**
 * Path prefix that sits between the origin and the hash route.
 * The new site serves the app under `/read`; the legacy site serves it at root.
 */
const NEXT_APP_PATH = "/read/";
/** Same prefix without the trailing slash, for `pathname` matching. */
const NEXT_APP_PATH_PREFIX = "/read";
const LEGACY_APP_PATH = "/";

/** True when `hostname` is one of the supported Readmoo web-app hosts. */
export function isReadmooHost(hostname: string): boolean {
  return READMOO_HOSTS.includes(hostname);
}

/** True when `pathname` sits under the new site's `/read` app root. */
function isNextAppPath(pathname: string): boolean {
  return (
    pathname === NEXT_APP_PATH_PREFIX || pathname.startsWith(NEXT_APP_PATH)
  );
}

/**
 * True when the given location parts point at the library (書櫃) page.
 *
 * Single source of truth for "am I on the bookshelf?", checked in three steps:
 *   1. `hostname` must be a supported Readmoo web-app host — a look-alike such
 *      as `next.readmoo.com.evil.com` is rejected.
 *   2. On the new site the app only exists under `/read`, so any other pathname
 *      is not the library even when the hash happens to match.
 *   3. The hash must be exactly `#/library` or a sub-route of it (`#/library/…`).
 *      The `/` boundary is required so a sibling route like `#/librarything`
 *      does not pass a naive prefix test.
 */
export function isLibraryUrl(
  hostname: string,
  pathname: string,
  hash: string,
): boolean {
  if (!isReadmooHost(hostname)) return false;
  if (hostname === READMOO_HOST_NEXT && !isNextAppPath(pathname)) return false;
  return hash === LIBRARY_HASH || hash.startsWith(`${LIBRARY_HASH}/`);
}

/**
 * Build an absolute Readmoo web-app URL for the given hash route.
 *
 *   next   → `https://next.readmoo.com/read/{hash}`
 *   legacy → `https://read.readmoo.com/{hash}`
 *
 * Unknown hostnames fall back to the LEGACY host and format: this function is
 * used to navigate the user somewhere that actually exists, so an unrecognised
 * host must not be echoed back into the URL.
 */
export function readmooAppUrl(hostname: string, hash: string): string {
  if (hostname === READMOO_HOST_NEXT) {
    return `https://${READMOO_HOST_NEXT}${NEXT_APP_PATH}${hash}`;
  }
  return `https://${READMOO_HOST_LEGACY}${LEGACY_APP_PATH}${hash}`;
}

/**
 * DOM selectors for the Readmoo library page.
 *
 * `*Legacy` entries target the pre-migration markup and exist only so the
 * extension keeps working on `read.readmoo.com`. Verified against the new site
 * on 2026-08-04; the item markup is now:
 *
 *   div.library-item
 *     div.cover-outer > div.cover-container > div.cover > a.reader-link > img.cover-img
 *     div.cover-outer > div.desktop-overlay > div.openbook-overlay
 *         ├ div.detail > span > i.mo.mo-ellipsis-horizontal
 *         ├ div.privacy#privacy-{bookId} > span
 *         └ div.menu-status > div.dropdown > button.dropdown-toggle
 *     div.info > (div.progress, div.title[title], div.star-rating)
 *
 * Two things moved: `.openbook` was renamed `.openbook-overlay` (wrapped in a
 * new `.desktop-overlay`), and `a.reader-link` moved out of the overlay into
 * `.cover`. Everything else below is valid on BOTH sites.
 */
export const READMOO_SELECTORS = {
  /** Book card container. */
  libraryItem: ".library-item",
  /** Book title, item-scoped. Read from the `title` attribute. */
  title: ".info .title[title]",
  /** Cover image, item-scoped. */
  coverImg: ".cover-img[src]",
  /** Fallback bookId source (`id="privacy-{bookId}"`), item-scoped. */
  privacyId: ".privacy[id^='privacy-']",
  /** Marks a borrowed (借入) book, item-scoped. */
  borrowedBadge: '[type="borrowed"]',
  /** Hover-revealed action overlay, item-scoped. */
  overlay: ".openbook-overlay",
  overlayLegacy: ".openbook",
  /** 「⋯」 detail button inside the overlay, item-scoped. */
  detailTrigger: ".openbook-overlay .detail span",
  detailTriggerLegacy: ".openbook .detail span",
  /** Looser detail-button match used when the inner `span` is absent. */
  detailTriggerLoose: ".openbook-overlay .detail",
  detailTriggerLooseLegacy: ".openbook .detail",
  /** Reader link carrying the bookId in its href, item-scoped. */
  readerLink: ".cover a.reader-link[href]",
  readerLinkLegacy: ".openbook a.reader-link[href]",
  /** Top navigation button (page-level). */
  topNavBtn: ".desktop-top-nav-btn",
  /** Profile panel on the `#/me` page (page-level). */
  mePanel: ".me-panel",
} as const;
