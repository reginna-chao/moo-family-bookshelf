import { isAllowedCoverUrl } from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Render-time whitelist for cover URLs that arrive from the SERVER (other
 * members' books, borrow requests, public shelves). Returns the URL when it
 * points at a Readmoo cover host, otherwise `""` so the caller falls back to
 * its own empty-cover placeholder instead of emitting an `<img src>`.
 *
 * The PWA's primary render-time defence is the `img-src` directive of the CSP
 * in `pwa/public/_headers`, but that file is only honoured by hosts that serve
 * it (Cloudflare Pages, Netlify). Under `vite dev` / `vite preview`, or on a
 * plain static host, no CSP header is sent at all — so a tracking-beacon cover
 * already stored server-side (borrow records have no TTL, and such values
 * predate the Worker's write-time check) would still leak the viewer's IP/UA
 * to a third party. This filter keeps those deployments covered and mirrors
 * `extension/src/dialog/safeCoverUrl.ts`; the host rule itself stays in
 * `shared/src/config/readmoo.ts`, never duplicated here.
 *
 * Deliberately NOT applied to the personal shelf: those covers are the user's
 * own data, so a hostile value there is self-inflicted, and existing rows may
 * predate any whitelist.
 */
export function safeCoverUrl(url: string): string {
  return isAllowedCoverUrl(url) ? url : "";
}
