import { isAllowedCoverUrl } from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Render-time whitelist for cover URLs that arrive from the SERVER (other
 * members' books, borrow requests). Returns the URL when it points at a
 * Readmoo cover host, otherwise `""` so the caller falls back to its own
 * empty-cover placeholder instead of emitting an `<img src>`.
 *
 * Why this exists on top of the Worker's write-time check: Readmoo pages send
 * NO Content-Security-Policy header, and the dialog is injected into those
 * pages, so the browser enforces no `img-src` restriction here — unlike the
 * PWA, which its own CSP covers. This is therefore the extension's ONLY
 * render-time defence against tracking-beacon covers that are already stored
 * server-side (borrow records have no TTL) from before the Worker rejected
 * them, and every such render would leak the viewer's IP/UA to a third party.
 *
 * Deliberately NOT applied to the personal shelf: those covers are the user's
 * own scraped data, so a hostile value there is self-inflicted, and local rows
 * may predate any whitelist.
 */
export function safeCoverUrl(url: string): string {
  return isAllowedCoverUrl(url) ? url : "";
}
