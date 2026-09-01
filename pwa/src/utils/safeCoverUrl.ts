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
  // `String()` is NOT redundant with the `string` parameter type. `coverUrl` is
  // one of the fields deliberately EXCLUDED from the runtime coercion in
  // `shared/src/api/safeText.ts`, so at runtime this argument is really
  // `unknown`: both API clients read their envelope through a bare cast, and the
  // endpoint is user-configurable. The whitelist then judges the value AFTER
  // `new URL` string-coerced it, so `["https://cdn.readmoo.com/x.jpg"]` is
  // ACCEPTED — and returning `url` on that branch would hand the ARRAY back
  // wearing a `string` type tag, ready to throw `TypeError` from render at the
  // first consumer that calls a string method on it (`useSearch` does exactly
  // that to `title`). Every consumer today only feeds this into `src=` or a
  // truthiness test, so it is a landmine rather than a live bug. For a real
  // string `String()` is the identity: no verdict and no returned value changes.
  return isAllowedCoverUrl(url) ? String(url) : "";
}
