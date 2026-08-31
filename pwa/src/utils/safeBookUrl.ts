import { isAllowedBookUrl } from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Render-time whitelist for the per-book detail link (`readmooUrl`) that
 * arrives from the SERVER (other members' books). Returns the URL when it
 * points at a Readmoo domain, otherwise `""`.
 *
 * Callers render it as `href={safeBookUrl(book.readmooUrl) || undefined}`
 * rather than passing the `""` straight through: an empty `href` resolves to
 * the CURRENT document, and because the same `<a>` carries `target="_blank"`,
 * clicking a blanked link would open a second copy of the PWA in a new tab — a
 * pointless navigation that misleads the user about what the link was for.
 * Omitting the attribute makes the `<a>` a plain non-interactive span per the
 * HTML spec, leaving layout and styling untouched. `readmooUrl: ""` is already
 * a legitimate stored value, so this also settles a pre-existing case rather
 * than only the hostile one.
 *
 * Unlike `safeCoverUrl`, no CSP can stand in for this filter: `img-src`
 * governs image loads and says nothing about where a navigation may go, and
 * the CSP in `pwa/public/_headers` is in any case only honoured by hosts that
 * serve that file (Cloudflare Pages, Netlify) — a self-hosted PWA on GitHub
 * Pages / S3 / nginx, or `vite dev` / `vite preview`, sends no CSP at all. An
 * off-whitelist value is a phishing / arbitrary-redirect lure presented under
 * a legitimate book title: following it lands the user on attacker-controlled
 * content, which learns their IP and User-Agent. The Referer header is NOT
 * part of that leak — the callers pair `target="_blank"` with
 * `rel="noopener noreferrer"`, and `noreferrer` suppresses the header
 * outright, so keep that attribute: it is load-bearing here, not boilerplate.
 * It needs a user click instead of firing on render like a hostile cover,
 * which lowers the rate but not the severity: the click happens precisely when
 * the user believes they are opening Readmoo. Mirrors
 * `extension/src/dialog/safeBookUrl.ts`; the domain rule itself stays in
 * `shared/src/config/readmoo.ts`, never duplicated here.
 *
 * Deliberately NOT applied to the personal shelf: those links come from the
 * user's own scraped data, so a hostile value there is self-inflicted — and
 * the personal-shelf rows render no link at all.
 */
export function safeBookUrl(url: string): string {
  return isAllowedBookUrl(url) ? url : "";
}
