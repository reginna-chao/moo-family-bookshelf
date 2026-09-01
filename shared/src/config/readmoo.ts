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

/**
 * Registrable domains that may serve Readmoo book-cover images.
 * Covers observed on readmoo.com are served from cdn.readmoo.com and
 * cdn.readmoo.tw, so both registrable domains are allowed (any subdomain).
 */
export const READMOO_COVER_DOMAINS: readonly string[] = [
  "readmoo.com",
  "readmoo.tw",
];

/**
 * True when `hostname` is a cover domain or a subdomain of one.
 *
 * The leading `.` boundary is required so a look-alike registration such as
 * `evilreadmoo.com` — or a deeper `readmoo.com.evil.com` — is rejected, the
 * same defence `isReadmooHost` above gets from its exact-match list.
 */
export function isReadmooCoverHost(hostname: string): boolean {
  return READMOO_COVER_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

/**
 * Probe base for the base-sensitivity check in {@link isAllowedReadmooUrl}.
 *
 * Two properties are load-bearing:
 *   - The scheme MUST be `https:`. WHATWG only enters "relative" state when the
 *     base scheme equals the input's scheme, so a base on any other scheme
 *     would make the check inert rather than strict.
 *   - `base.invalid` is reserved by RFC 2606, can never resolve and can never
 *     be a Readmoo domain, which is what rules out a false "stable" verdict
 *     (see the core's JSDoc).
 * The nested path merely keeps relative resolution off the root.
 */
const BASE_SENSITIVITY_PROBE = "https://base.invalid/a/b";

/**
 * The canonical absolute-https spelling. Used ONLY by the fast path in
 * {@link isAllowedReadmooUrl} to early-accept a subset that is provably
 * base-independent — never as a criterion, and never to reject anything.
 * Read that function's "Fast path" section before touching this.
 */
const ABSOLUTE_HTTPS_PREFIX = "https://";

/**
 * Shared core of the two URL whitelists below: `url` must parse as an https://
 * URL on an allowed Readmoo registrable domain with the default port, AND must
 * mean the same thing with or without a base document.
 *
 * `parsed.port === ""` requires the default port: the WHATWG URL parser
 * normalises an explicit `:443` on https away, so `https://cdn.readmoo.com:443`
 * passes while `:8443` does not. That keeps acceptance here aligned with CSP
 * host-source semantics, which only match the default port.
 *
 * The base-sensitivity check runs last because it costs a second parse: the
 * `href` resolved against {@link BASE_SENSITIVITY_PROBE} must equal the one
 * resolved standalone. It exists because what we validate is the STRING, while
 * what a browser later resolves is that same string against the rendering
 * document. What it therefore rejects is "this string means something DIFFERENT
 * once a base document is involved" — NOT "this string is missing a literal
 * `//`". Those two sets are not the same, and conflating them is the mistake
 * this paragraph exists to prevent.
 *
 * WHATWG decides it on how many slash-ish characters follow `https:` — for a
 * special scheme `\` is treated as `/`, so the run is counted over BOTH:
 *   - 0 or 1 → base-SENSITIVE. Parsed standalone the host still comes from the
 *     string ("special authority ignore slashes" state), but against a
 *     same-scheme base the parser drops into "relative" state and takes the
 *     host from the BASE. These are the only forms this check rejects:
 *     `https:readmoo.com/../../p` (0), `https:/readmoo.com/y` and
 *     `https:\readmoo.com/y` (1).
 *   - 2 or more → base-INDEPENDENT. The parser reaches "special authority
 *     ignore slashes" state with or without a base (via "relative slash" state
 *     for the backslash spellings) and skips the whole run, so the host is read
 *     from the string either way.
 *
 * Without that check an attacker-supplied `readmooUrl` / `coverUrl` of a
 * base-sensitive shape passes the scheme / host / port tests above and then
 * loads/navigates on the VIEWER's own origin: the observed exploit sent a PWA
 * reader to the PWA's own `/public/x#invite=…`, which the SPA fallback answers
 * by clearing the stored session and pre-filling the attacker's sync code.
 *
 * Why this check is sufficient and does not over-block:
 *   - Any ordinary absolute URL (`https://host/path`) resolves identically with
 *     and without a base, so it is unaffected — including a userinfo look-alike
 *     such as `https://readmoo.com@evil.com/x`, which keeps being rejected on
 *     the host check as before.
 *   - Non-canonical but base-stable spellings stay ALLOWED, and that is
 *     correct: `https:\\readmoo.com/x`, `https:/\readmoo.com/x`,
 *     `https:\/readmoo.com/x`, `https:///readmoo.com/x` and
 *     `https:////readmoo.com/x` all resolve to `https://readmoo.com/x` in every
 *     browser, base or no base, so each is a genuine absolute Readmoo URL. The
 *     first three carry no literal `//` at all — which is precisely why this
 *     check must never be re-derived from a `//` test.
 *   - The only theoretical false "stable" verdict is a string that already
 *     resolves onto the probe host itself, and `isReadmooCoverHost` rejects
 *     `base.invalid`.
 *   - The second `new URL` cannot throw: the standalone parse has already
 *     succeeded, and supplying a base never turns a parseable string into an
 *     unparseable one.
 *
 * Fast path — an EARLY-ACCEPT of a provably safe subset, NOT a second
 * criterion. The line reads
 * `typeof url === "string" && url.startsWith(ABSOLUTE_HTTPS_PREFIX)`, whose
 * second half is shaped exactly like the `//` test banned one paragraph up, so
 * the difference is spelled out here rather than left to the reader: the
 * CRITERION is, and stays, base-invariance; the prefix test only recognises
 * inputs for which that invariance is already proven, and skips re-proving it
 * with a second parse. The first half is not decoration — see the fourth
 * "way to break it" below.
 *
 * Why the subset is sound: if the string LITERALLY begins `https://`, the host
 * can only come from the string, so no base can change the verdict. Standalone
 * the parser runs scheme → "special authority slashes" → "special authority
 * ignore slashes" → authority; against a same-scheme base it runs scheme →
 * "special relative or authority", where c is `/` and the remainder starts with
 * `/`, which lands on that same "special authority ignore slashes" state. Both
 * branches reach authority state, and past it nothing consults the base — host,
 * port, path, query and fragment are all read from the string — so the two
 * `href`s are equal by construction. Together with the three checks above
 * (https, default port, allowed host) that already passed, reaching this line
 * means the string is an ordinary absolute Readmoo URL. No false positive
 * exists to find.
 *
 * Four ways to break it, all tempting:
 *   - Widening it to `includes("//")`, or any other "has slashes" test.
 *     POSITION carries the whole argument: `https:/readmoo.com//x` contains a
 *     literal `//`, is base-SENSITIVE, and must stay rejected.
 *   - Using it to REJECT. It may only ever return true early; a miss means "not
 *     provably safe YET", never "unsafe". Every miss falls through to the full
 *     comparison, which is what keeps `HTTPS://readmoo.com/x`,
 *     `  https://readmoo.com/x` (leading spaces), `https:\\readmoo.com/x` and
 *     `https:/\readmoo.com/x` allowed, exactly as they were before this fast
 *     path existed.
 *   - Promoting it to the criterion. `https:\\readmoo.com/x` carries no `//` at
 *     all yet is a genuine absolute Readmoo URL — the very fact that forbids a
 *     `//` criterion equally forbids this subset from becoming one.
 *   - Dropping the `typeof url === "string"` guard as redundant, because the
 *     parameter is DECLARED `string`. It is not redundant: it is the only
 *     runtime type check on this path, and it is what keeps the fast path from
 *     CHANGING behaviour for non-strings rather than merely accelerating it.
 *     The declaration is a compile-time claim that does not survive to runtime
 *     here — both API clients read their envelope through a bare cast
 *     (`(await response.json()) as ApiResponse<T>`), the endpoint is
 *     user-configurable (a sync code's `@host` segment repoints the whole app
 *     at a self-hosted backend), and `coverUrl` / `bookCoverUrl` are precisely
 *     the fields deliberately EXCLUDED from the runtime coercion in
 *     `shared/src/api/safeText.ts`, so a hostile or buggy backend really can
 *     land a non-string in `safeCoverUrl` → {@link isAllowedCoverUrl} → here.
 *     Every `new URL` below stringifies its argument instead of throwing on a
 *     non-string — `new URL(["https://readmoo.com/x"])` parses fine — so an
 *     unguarded `.startsWith` is the ONE member-called string method on this
 *     path, and it throws `TypeError` on an array. That throw escapes from
 *     render, where no caller `try` can reach it, and with no ErrorBoundary in
 *     either app it is a permanent white screen. Guarded, a non-string simply
 *     falls through to the full comparison and keeps the exact verdict it had
 *     before this fast path existed.
 *
 * Measured before adding it (interleaved variants, 200 warm-up rounds, 60 timed
 * rounds, median, 1000 books/member):
 *   - `JSON.parse` of the whole record    0.213 ms
 *   - pre-whitelist, cover only, 1 parse  0.540 ms  (0.540 µs/URL)
 *   - cover + book link, base-invariance  2.615 ms  (1.307 µs/URL)
 *   - the same, with this fast path       1.075 ms  (0.537 µs/URL)
 * So the whitelist cost 12.3× the `JSON.parse` of the very record it validates,
 * and the fast path removes 59% of that, putting the per-URL cost back at the
 * pre-fix single parse (0.537 vs 0.540 µs). It is worth the paragraphs above
 * because `GET /api/family/:id/bookshelf` runs this per book per member:
 * 4 members × 1000 shared books ≈ 10.5 ms of pure whitelist CPU against the
 * Workers free tier's 10 ms CPU per request, versus ≈ 4 ms with the fast path.
 * (A re-run on a second machine reproduced the whitelist figures and the ~60%
 * cut, but measured `JSON.parse` about twice as expensive, putting that
 * multiple nearer 6× — the ratio moves with record shape and V8 state; the
 * whitelist's own absolute cost does not.)
 *
 * This deliberately tightens BOTH exports, including the `400 INVALID_COVER_URL`
 * boundary in `worker/src/routes/borrow.ts`. Legitimate clients never emit a
 * base-sensitive URL — the scraper reads already-absolute `href` / `src` values
 * off the Readmoo DOM — so the new rejections are intended, not collateral.
 *
 * File-local on purpose. The two exported wrappers are separate trust
 * boundaries and must stay separately tightenable, but they must not drift into
 * two independently maintained parsers.
 */
function isAllowedReadmooUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    !isReadmooCoverHost(parsed.hostname)
  ) {
    return false;
  }
  // Early-accept only, never a rejection and never the criterion: a literal
  // `https://` prefix is a subset that is provably base-independent, so the
  // second parse below can be skipped. Everything else falls through to it and
  // is judged by base-invariance exactly as before.
  //
  // The `typeof` guard is load-bearing, NOT redundant with the `string`
  // parameter type: this is the only member call on `url` (both `new URL`
  // stringify instead), so at runtime it is the one place a non-string from a
  // BYO backend could throw. Keeping it makes the fast path purely an
  // accelerator. See "Fast path" above before removing either half.
  if (typeof url === "string" && url.startsWith(ABSOLUTE_HTTPS_PREFIX)) {
    return true;
  }
  return new URL(url, BASE_SENSITIVITY_PROBE).href === parsed.href;
}

/**
 * True when `url` parses as an https:// URL on an allowed Readmoo cover host
 * with the default port. Used by the Worker to refuse attacker-controlled
 * cover URLs (privacy tracking beacons) at the API boundary; the PWA CSP
 * img-src mirrors the same domain list.
 *
 * Kept as its own export rather than merged with {@link isAllowedBookUrl},
 * even though both delegate to the same core today: a cover feeds `<img src>`
 * and a book link feeds `<a href>`, which are different trust boundaries. If
 * covers are ever narrowed (e.g. to `cdn.` hosts only), that must not silently
 * blank every book link too.
 */
export function isAllowedCoverUrl(url: string): boolean {
  return isAllowedReadmooUrl(url);
}

/**
 * True when `url` parses as an https:// URL on an allowed Readmoo domain with
 * the default port. Guards the per-book detail link (`readmooUrl`), which the
 * Extension and the PWA render as a clickable `<a href>`.
 *
 * Used by the Worker at the books write boundary and again on the read paths
 * (`sanitizeReadmooUrl` in `worker/src/utils/validation.ts`): a family member
 * can bypass the UI and POST any URL, so an off-domain link is a phishing /
 * arbitrary-redirect lure served under a legitimate book title — the click
 * lands the viewer on attacker-controlled content, which learns their IP and
 * User-Agent. The Referer header does NOT leak: every render site pairs
 * `target="_blank"` with `rel="noopener noreferrer"`, and `noreferrer`
 * suppresses that header outright, so the attribute is load-bearing there
 * rather than boilerplate. Firing takes a user click, unlike a cover, which
 * loads by itself — that lowers the rate, not the severity, because the click
 * comes exactly when the user believes they are opening Readmoo.
 *
 * Deliberately NOT built on `isReadmooHost`: that exact-match list holds only
 * the web-app hosts (`next.` / `read.`), while every legitimate book link lives
 * on the apex — `https://readmoo.com/book/{bookId}`, see `READMOO_BOOK_BASE` in
 * `extension/src/content/scraper.ts` — so reusing it would blank all of them.
 *
 * Separate export from {@link isAllowedCoverUrl} on purpose; see that JSDoc.
 */
export function isAllowedBookUrl(url: string): boolean {
  return isAllowedReadmooUrl(url);
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
