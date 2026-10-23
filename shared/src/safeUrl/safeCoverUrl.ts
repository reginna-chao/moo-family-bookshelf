import { isAllowedCoverUrl } from "../config/readmoo";

/**
 * Render-time whitelist for cover URLs that arrive from the SERVER (other
 * members' books, borrow requests, public shelves). Returns the URL when it
 * points at a Readmoo cover host, otherwise `""` so the caller falls back to
 * its own empty-cover placeholder instead of emitting an `<img src>`.
 *
 * Why this exists on top of the Worker's write-time check: a tracking-beacon
 * cover already stored server-side (borrow records have no TTL, and such values
 * predate the Worker's write-time check) would leak the viewer's IP/UA to a
 * third party on every render, and neither app can count on the browser to
 * block it.
 * - Extension: Readmoo pages send NO Content-Security-Policy header, and the
 *   dialog is injected into those pages, so the browser enforces no `img-src`
 *   restriction there. This filter is the Extension's ONLY render-time defence.
 * - PWA: its primary render-time defence is the `img-src` directive of the CSP
 *   in `pwa/public/_headers`, but that file is only honoured by hosts that
 *   serve it (Cloudflare Pages, Netlify). Under `vite dev` / `vite preview`, or
 *   on a plain static host, no CSP header is sent at all; this filter keeps
 *   those deployments covered.
 * The host rule itself stays in `shared/src/config/readmoo.ts`, never
 * duplicated here.
 *
 * Deliberately NOT applied to the personal shelf: those covers are the user's
 * own scraped data, so a hostile value there is self-inflicted, and existing
 * rows may predate any whitelist.
 */
export function safeCoverUrl(url: string): string {
  // `String()` is not redundant: `coverUrl` skips the text layer, so an accepted array would otherwise
  // leave typed as `string`. Both `safe*Url` files keep it — docs/architecture.md → 伺服器回傳資料的檢查.
  return isAllowedCoverUrl(url) ? String(url) : "";
}
