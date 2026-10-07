import { describe, it, expect } from "vitest";
import {
  LIBRARY_HASH,
  ME_HASH,
  READMOO_COVER_DOMAINS,
  READMOO_HOSTS,
  READMOO_HOST_LEGACY,
  READMOO_HOST_NEXT,
  READMOO_MATCH_PATTERNS,
  READMOO_ORIGINS,
  isAllowedBookUrl,
  isAllowedCoverUrl,
  isLibraryUrl,
  isReadmooCoverHost,
  isReadmooHost,
  readmooAppUrl,
} from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Readmoo host / URL config in `shared/src/config/readmoo.ts`: the host and
 * cover-domain predicates, and the two URL whitelists `isAllowedCoverUrl` /
 * `isAllowedBookUrl` that share one file-local core.
 *
 * Backslash encoding: `BACKSLASH` is built from its character code so that no
 * escaping layer — a TypeScript string literal, Prettier, a diff viewer, a
 * reviewer's eye — can turn one into two. The single/double distinction decides
 * the verdict in the tables (`https:\readmoo.com/x` is rejected,
 * `https:\\readmoo.com/x` is allowed), and it is exactly the kind of detail an
 * escaping slip inverts silently, so every generated case is also read back
 * (`expectRunEncoding`, the escaping tripwire) and asserted on how many
 * backslashes actually survived into it — without it, a slip anywhere between
 * `String.fromCharCode(92)` and the final URL would quietly move a case to the
 * other side of the boundary while the suite stayed green.
 *
 * `ABSOLUTE_HTTPS_PREFIX` is the canonical absolute spelling that production's
 * fast path early-accepts. Deliberately re-stated rather than imported: it is
 * file-local in `shared/src/config/readmoo.ts` on purpose, and this subset is the
 * SUBJECT of the tests, not a rule they inherit.
 *
 * Separator-run table (`separatorRunCases`): exhaustive over the one property
 * these shapes' verdict turns on — how many slash-ish characters follow
 * `https:`. WHATWG treats `\` like `/` for a special scheme, so the run is
 * counted over BOTH characters, and the boundary sits between 1 and 2:
 *   - 0 or 1 → base-SENSITIVE. Against a same-scheme base the parser drops into
 *     "relative" state and takes the host from the BASE, so the string means
 *     something else in the document it is rendered into ⇒ must be rejected.
 *   - 2 or more → base-INDEPENDENT. The host is read from the string with or
 *     without a base ⇒ a genuine absolute Readmoo URL ⇒ must be allowed.
 * Enumerating all 31 combinations pins WHERE that boundary is rather than
 * sampling either side of it, and it exercises both production paths at once.
 * `FAST_PATH_RUN_COUNT` (7) is how many runs begin `//` — 1 of length 2, 2 of
 * length 3, 4 of length 4 — exactly the runs whose URL LITERALLY starts
 * `https://`, so exactly the subset the fast path early-accepts without
 * re-proving base-invariance (`///` and `//\` among them, because that test is a
 * PREFIX test and not an "exactly two" one); they are the rows
 * `expectAbsoluteRowsAreBaseInvariant` most needs to see. `\\`, `/\`, `\/` and
 * `\//` miss the fast path and must still be allowed by the full base-invariance
 * comparison behind it. A fast path that started REJECTING on a miss, or one
 * promoted from an early-accept to the criterion, turns that second group red.
 *
 * `SAME_SCHEME_BASES`: the scheme must MATCH the input's — WHATWG only enters
 * "relative" state for a same-scheme base, so a base on any other scheme could
 * never disprove invariance. The first is the document the extension dialog is
 * injected into; the second stands for any other viewer origin (the PWA renders
 * the same stored values).
 *
 * `expectAbsoluteRowsAreBaseInvariant` pins the property the fast path rests on:
 * a string that LITERALLY begins `https://` resolves to the same `href` with or
 * without a base document.
 *  - Why it needs pinning now: until the fast path existed, the core PROVED
 *    base-invariance for every accepted string by comparing the standalone parse
 *    against a parse with a base — a runtime that resolved some `https://` string
 *    differently against a base would have been rejected, fail-closed, without
 *    anyone noticing. The fast path skips that comparison for this subset, which
 *    promotes the WHATWG guarantee from a convenience to a load-bearing
 *    assumption: inside the subset a parser deviation is now accepted silently.
 *    This test is what would notice.
 *  - Driven by the caller's own rows, never a fresh whitelist, so every
 *    `https://` row anyone adds there is covered once the expected count is
 *    bumped. NOT automatic, deliberately: `expectedChecked` is hard-coded at each
 *    call site, so a newly added row turns the test red until someone updates
 *    that number — the friction is the price of the hole it closes. Unparseable
 *    inputs are skipped, matching production: the core reaches the prefix test
 *    only after `new URL(url)` has already succeeded.
 *  - Callers pass BOTH their hand-written matrix and the exhaustive separator
 *    table, because the matrix alone spells only the canonical `https://` form.
 *    The table covers the six NON-canonical spellings the fast path also
 *    early-accepts — `https:///…`, `https://\…`, `https:////…`, `https:///\…`,
 *    `https://\/…` and `https://\\…` — precisely the shapes most likely to
 *    diverge between parsers. The table's own rows cannot stand in for this:
 *    they assert a `true` verdict against a hand-derived `expected`, so if an
 *    engine ever made one of those forms base-SENSITIVE, the fast path would
 *    return true anyway and the table would stay green.
 *  - `expectedChecked` pins how many rows survived the filter. A bare "> 0" would
 *    let the separator spread be deleted at a call site — the hand-written rows
 *    would keep passing while the fast-path shapes went back to being uncovered.
 *
 * isAllowedCoverUrl: the Worker's write-time whitelist for `bookCoverUrl` on
 * borrow-create (worker/src/routes/borrow.ts → `400 INVALID_COVER_URL`). A cover
 * URL is rendered into an `<img src>` on every family member's screen, so an
 * attacker-chosen host would leak each viewer's IP / UA to a third party; the
 * whole matrix is that beacon defence. The "nested path plus query string" row
 * (and the book matrix's hash-route row, the shape `readmooAppUrl` builds) guard
 * the base-sensitivity check against over-blocking: it compares full `href`s, so
 * those must survive resolution byte-for-byte (real CDN covers carry both).
 *
 * Base-sensitive rows (cover matrix): the four REJECTED rows share ONE attack
 * primitive — a scheme with no `//` (the fifth is the accepted doubled-backslash
 * boundary case). The predicate validates the STRING, but the browser resolves
 * that same string against the document it is rendered INTO. WHATWG reads these
 * forms through "special authority ignore slashes" state when NO base is given —
 * host = `cdn.readmoo.com`, so the scheme / port / host checks all pass — and
 * through "relative" state when the base carries the same scheme, where the host
 * silently becomes the BASE's instead. On a cover the payoff needs no click and
 * no user mistake: the dialog is injected INTO a Readmoo page, so the base is
 * `https://next.readmoo.com/read/…` and the `<img src>` fires an authenticated
 * same-site GET at an attacker-chosen Readmoo path the moment the card renders,
 * carrying the viewer's Readmoo cookies; in the PWA the same string lands on the
 * PWA's own origin instead. No CSP `img-src` catches either one, because the
 * origin it resolves to is the rendering page's OWN — which any usable policy
 * already allows. No other rejected row lands there: the foreign-host rows
 * (`evilreadmoo.com`, the userinfo smuggle) are third-party by name, and the
 * rows that spell out a first-party host (plain HTTP, a non-default port, a
 * non-HTTP scheme, the trailing-dot FQDN) each resolve to an origin DISTINCT
 * from the rendering page's, which a whitelist or a CSP can still name and
 * refuse. Confirmed exploitable: each row returned TRUE until the core started
 * comparing the standalone parse against a parse with a base. Ordinary absolute
 * URLs resolve identically either way, so the accepted rows pin that the fix
 * does not over-block. The "rejects … once a rendering page supplies the base"
 * tests are the executable statement of WHY, so the rows are not mistaken for
 * over-caution and deleted: their first two assertions are the PREMISE (they pin
 * the parser disagreement the attack rests on, so a future engine that stopped
 * treating the shape as base-sensitive is reported instead of quietly passing);
 * the last is the production contract — the whitelist must refuse a string whose
 * meaning depends on where it is rendered, because the whitelist is applied to
 * the string and the browser is not.
 *
 * Doubled backslash (both matrices): the boundary companion to the
 * single-backslash row, and the reason the predicate tests base-SENSITIVITY
 * rather than blocking backslashes outright. WHATWG's "relative slash state"
 * treats a `\` in a special scheme exactly like `/`, so a PAIR of them reaches
 * "special authority ignore slashes" state and the host is read from the STRING
 * — with or without a base. Verified identical in Node's parser and in
 * whatwg-url (what jsdom and the browsers implement), so it really is an
 * absolute URL in every rendering context, and accepting it is correct. Kept as
 * an executable note so the single-backslash row is not misread as "backslashes
 * are rejected". Rejecting this shape anyway would be a defensible extra
 * tightening — it is just not what the base-sensitivity fix does, and this row
 * is what would flag the change.
 *
 * `//`-widening tripwire (both matrices): guards the ONE widening the fast path
 * invites — relaxing its `url.startsWith("https://")` early-accept into
 * `url.includes("//")`, or any other "there is a `//` in here somewhere" test.
 * The row's string DOES carry a literal `//` — in the PATH — while only ONE
 * slash follows the scheme, so it is base-SENSITIVE and must stay rejected. The
 * widening would early-accept it and this row alone turns red — but NOT because
 * it is the only rejected row containing a `//`: plain HTTP, the `ftp:` scheme
 * (cover matrix only), a non-default port, the protocol-relative form, the
 * userinfo smuggle, the two look-alike hosts and the trailing-dot FQDN carry one
 * too. Every one of those is refused earlier — by the parse itself, or by the
 * scheme / port / host checks that run BEFORE the fast path is consulted. This
 * row is the only rejected one
 * that BOTH reaches the fast path and contains a literal `//`. The criterion is
 * base-INVARIANCE, not the presence or absence of `//`; POSITION carries the
 * whole argument, in both directions: `//` in the path proves nothing (this
 * row), and the doubled-backslash row is allowed with no `//` anywhere in it.
 * The "whose path contains a literal //" tests are the executable form, so the
 * row cannot decay: an edit that dropped the `//` from that URL would leave the
 * row passing while no longer guarding anything. They pin the two facts that
 * make it a tripwire — the literal `//` is present, and the string is still NOT
 * of the shape the fast path may early-accept — next to the parser disagreement
 * that forces the rejection.
 *
 * isAllowedBookUrl: the whitelist for the per-book detail link (`readmooUrl`),
 * which the Extension and the PWA render as a clickable `<a href>` and the
 * Worker sanitises on both the books write paths and the family-bookshelf /
 * public-snapshot read paths. Different trust boundary from the cover matrix: a
 * cover is an `<img src>` that fires a request on RENDER, while a book link
 * needs a click. That lowers the rate but not the severity — the click happens
 * precisely when the user believes they are opening Readmoo, so an off-domain
 * value is a phishing / arbitrary-redirect lure served under a legitimate book
 * title, and the destination host learns the viewer's IP and User-Agent. It does
 * not learn the referer: every render site pairs the href with `rel="noopener
 * noreferrer"`, and `noreferrer` suppresses the Referer header outright — that
 * attribute is load-bearing, so dropping it would widen this exposure. No CSP
 * substitutes for the whitelist either: `img-src` governs image loads and says
 * nothing about navigation. This is the ONLY exhaustive matrix for the rule, so
 * it is written full even though `isAllowedCoverUrl` shares the same core today:
 * the two are separately tightenable by design, so neither matrix may be
 * replaced by "these two agree" — which is also why the base-sensitive rows,
 * the doubled-backslash row and the `//` tripwire are restated in it.
 *  - Base-sensitive book rows: WHATWG resolves them with host = `readmoo.com`
 *    and no base (every check passes) but host = the BASE's against a
 *    same-scheme base, so the whitelist certifies "this points at Readmoo" while
 *    the `<a href>` points at the VIEWER's own origin. That is the observed
 *    exploit, and it is worse than a plain off-domain phishing link: the target
 *    is same-origin, so the viewer sees their own trusted URL bar. The reported
 *    chain sent a PWA reader to the PWA's own `/public/x#invite=moo-x`, which the
 *    SPA fallback answers by clearing the stored session and pre-filling the
 *    attacker's sync code — i.e. it drives the app's OWN join flow, something no
 *    third-party destination could do. `rel="noopener noreferrer"` is no help:
 *    it hardens where a link LANDS, not which origin it resolves to. Confirmed
 *    exploitable: each row returned TRUE until the core started comparing the
 *    standalone parse against a parse with a base.
 *  - Apex trap (anti-drift tripwire): `isReadmooHost` looks like the obvious
 *    predicate to reuse, but its exact-match list holds only the two WEB-APP
 *    hosts (next. / read.), while every legitimate book link lives on the APEX —
 *    `readmooUrl` is built as `${READMOO_BOOK_BASE}${bookId}` with
 *    `READMOO_BOOK_BASE = "https://readmoo.com/book/"`
 *    (extension/src/content/scraper.ts:31). Rebuilding `isAllowedBookUrl` on
 *    `isReadmooHost` would blank EVERY real book link — a total feature outage
 *    that no hostile-URL test would catch, because all the hostile cases would
 *    still (correctly) return false.
 *
 * Non-string input (both whitelists): runtime robustness against the one thing
 * their `url: string` parameter cannot promise. The value arrives from the
 * BACKEND, and nothing on the way narrows its type:
 *  - Both API clients read the `{ data, error }` envelope through a bare cast
 *    (`extension/src/api/client.ts`, `pwa/src/api/client.ts`), so the declared
 *    shape is an assumption about the server, not a checked fact.
 *  - The server is user-configurable. A sync code's `@host` segment points a
 *    whole family at a self-hosted Worker, which may predate any of these checks
 *    or be modified outright.
 *  - `coverUrl` is DELIBERATELY excluded from the runtime text coercion that
 *    guards its sibling fields. That exclusion is argued in docs/architecture.md
 *    → 伺服器回傳資料的檢查, which names the non-string describe below. The
 *    argument has TWO parts and both are load-bearing: these fields only render
 *    into an `<img src>` attribute, which the DOM string-coerces, AND they run
 *    through the Readmoo URL whitelist first, which guards its OWN input type.
 *    The second part is a property of the code under test HERE, and the
 *    non-string describe enforces it: if the whitelist ever drops that guard,
 *    the exclusion stops being safe and these fields have to be coerced in the
 *    text layer instead. `sanitizeBookText` accordingly coerces `readmooUrl`
 *    but not `coverUrl`, and `sanitizeFamilyBookshelfText` does not touch it
 *    either, so on the family-bookshelf path a non-string `coverUrl` reaches the
 *    render layer verbatim.
 * A JSON body whose `coverUrl` is `["https://cdn.readmoo.com/x.jpg"]` therefore
 * arrives at `safeCoverUrl` → `isAllowedCoverUrl` (extension/src/dialog/
 * BookCard.tsx:113 and its three twins) as an ARRAY. The DOM half of that
 * argument still holds for such a value; the whitelist half is precisely what
 * the rows buy, because a string method on an array throws and neither app
 * mounts an ErrorBoundary — so a throw there is a permanent white screen rather
 * than a blank cover. `isAllowedBookUrl` is asserted on the same inputs even
 * though its own field IS coerced today: the two exports are separate trust
 * boundaries over ONE file-local core, so the guard has to hold on both sides of
 * that split, and the coercion that currently protects `readmooUrl` is a
 * different module's decision that may change without anyone revisiting this one.
 *  - What regressed, and why the guard looks deletable: until the fast path
 *    landed the core only ever fed this parameter to `new URL(...)`, which
 *    coerces its argument with `String()` — an array of one URL string parsed
 *    fine and the base-invariance comparison answered `true`.
 *    `url.startsWith(...)` is the FIRST string method the core has ever called on
 *    it, and a string method on an array throws. The `typeof` guard in front of
 *    it therefore reads like dead weight next to a `string` parameter — this
 *    block is what turns red when someone tidies it away.
 *  - Both assertions per row are load-bearing. `not.toThrow()` alone would also
 *    be satisfied by a guard written as an early `return false`, which does not
 *    crash but silently blanks every legitimate cover and book link on that path
 *    — so each row also pins the verdict the core returned BEFORE the fast path
 *    existed. Inputs are cast at the call site; the production signature stays
 *    strict, and the cast is the honest spelling of what the network hands over.
 *  - `reachingCases`: the shapes that actually REACH the string method, and so
 *    the ones that threw. `String()` on a one-element array is that element,
 *    recursively, so both coerce to a genuine allowed Readmoo URL while being no
 *    string at all; every check ahead of the fast path — the parse, the scheme,
 *    the port, the host — passes on the coerced value, which is exactly why the
 *    input survives that far.
 *  - `unparseableCases`: non-strings that `String()` turns into something no URL
 *    parser accepts, so `new URL(value)` throws inside the core's own try/catch
 *    and the fast path is never reached. They pin the fail-closed half: a
 *    malformed field is refused, never propagated and never fatal.
 *
 * READMOO_COVER_DOMAINS: the PWA CSP derives `https://{d}` and `https://*.{d}`
 * from these entries (see pwa/tests/unit/cspHeaders.test.ts), which only works
 * while each entry is a bare registrable domain.
 */

describe("isReadmooHost", () => {
  const cases: Array<{ name: string; hostname: string; expected: boolean }> = [
    { name: "the new host", hostname: READMOO_HOST_NEXT, expected: true },
    { name: "the legacy host", hostname: READMOO_HOST_LEGACY, expected: true },
    {
      name: "a look-alike host that only suffixes the new host",
      hostname: "next.readmoo.com.evil.com",
      expected: false,
    },
    {
      name: "a look-alike host that only prefixes the legacy host",
      hostname: "evil-read.readmoo.com",
      expected: false,
    },
    {
      name: "the readmoo store host (not the web app)",
      hostname: "readmoo.com",
      expected: false,
    },
    { name: "an empty hostname", hostname: "", expected: false },
    {
      name: "the E2E fixture host",
      hostname: "localhost",
      expected: false,
    },
  ];

  for (const { name, hostname, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isReadmooHost(hostname)).toBe(expected);
    });
  }
});

describe("isReadmooCoverHost", () => {
  const cases: Array<{ name: string; hostname: string; expected: boolean }> = [
    { name: "the readmoo.com apex", hostname: "readmoo.com", expected: true },
    { name: "the readmoo.tw apex", hostname: "readmoo.tw", expected: true },
    { name: "the .com cover CDN", hostname: "cdn.readmoo.com", expected: true },
    { name: "the .tw cover CDN", hostname: "cdn.readmoo.tw", expected: true },
    {
      name: "a deeper subdomain of a cover domain",
      hostname: "a.b.readmoo.com",
      expected: true,
    },
    {
      // The cover list is deliberately WIDER than READMOO_HOSTS: any Readmoo
      // subdomain may serve an image, while only two hosts serve the web app.
      name: "the web-app host (a subdomain of a cover domain)",
      hostname: READMOO_HOST_NEXT,
      expected: true,
    },
    {
      name: "a look-alike that only prefixes a cover domain",
      hostname: "evilreadmoo.com",
      expected: false,
    },
    {
      name: "a look-alike that only suffixes a cover domain",
      hostname: "readmoo.com.evil.com",
      expected: false,
    },
    {
      name: "a look-alike that only suffixes the .tw cover domain",
      hostname: "readmoo.tw.evil.com",
      expected: false,
    },
    {
      name: "the same brand on another TLD",
      hostname: "readmoo.org",
      expected: false,
    },
    { name: "an empty hostname", hostname: "", expected: false },
  ];

  for (const { name, hostname, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isReadmooCoverHost(hostname)).toBe(expected);
    });
  }
});

/** A single backslash, built from its character code so no escaping layer can turn
 *  one into two. See the header → "Backslash encoding". */
const BACKSLASH = String.fromCharCode(92);

/** The scheme prefix every separator-run case is built on. */
const HTTPS_SCHEME = "https:";

/** The fast path's early-accept prefix, deliberately re-stated (it is file-local in
 *  production and the SUBJECT of these tests). */
const ABSOLUTE_HTTPS_PREFIX = "https://";

/** Longest separator run the exhaustive table enumerates. */
const MAX_SEPARATOR_RUN = 4;

/** 2^0 + 2^1 + 2^2 + 2^3 + 2^4 — every run up to {@link MAX_SEPARATOR_RUN}. */
const SEPARATOR_RUN_COUNT = 31;

/** Runs beginning `//` (1 + 2 + 4): exactly the fast path's early-accept subset.
 *  See the header → "Separator-run table". */
const FAST_PATH_RUN_COUNT = 7;

/** How many characters of `text` equal `char`. */
function countChar(text: string, char: string): number {
  return [...text].filter((c) => c === char).length;
}

/** Every string of exactly `length` characters drawn from `/` and `\`. */
function separatorRuns(length: number): string[] {
  if (length === 0) return [""];
  return separatorRuns(length - 1).flatMap((run) => [
    `${run}/`,
    `${run}${BACKSLASH}`,
  ]);
}

/** Spell a run out, so `\` and `\\` cannot be misread in test output. */
function spellRun(run: string): string {
  if (run === "") return "no separator";
  return [...run].map((c) => (c === "/" ? "slash" : "backslash")).join(" + ");
}

interface SeparatorRunCase {
  /** The `/`-and-`\` run that follows `https:`. */
  run: string;
  length: number;
  url: string;
  expected: boolean;
}

/** All 31 `/`-and-`\` runs after `https:`: 0–1 → rejected, 2+ → allowed.
 *  See the header → "Separator-run table". */
function separatorRunCases(target: string): SeparatorRunCase[] {
  const cases: SeparatorRunCase[] = [];
  for (let length = 0; length <= MAX_SEPARATOR_RUN; length += 1) {
    for (const run of separatorRuns(length)) {
      cases.push({
        run,
        length,
        url: `${HTTPS_SCHEME}${run}${target}`,
        expected: length >= 2,
      });
    }
  }
  return cases;
}

/** Escaping tripwire: reads the run back off the exact string handed to the
 *  predicate. See the header → "Backslash encoding". */
function expectRunEncoding(runCase: SeparatorRunCase, target: string): void {
  const { url, run, length } = runCase;
  expect(BACKSLASH).toHaveLength(1);
  expect(BACKSLASH.charCodeAt(0)).toBe(92);
  // The run is exactly `length` characters, all of them separators …
  expect(run).toHaveLength(length);
  expect(countChar(run, "/") + countChar(run, BACKSLASH)).toBe(length);
  // … it sits verbatim between the scheme and the target …
  expect(url.slice(0, HTTPS_SCHEME.length)).toBe(HTTPS_SCHEME);
  expect(url.slice(HTTPS_SCHEME.length, HTTPS_SCHEME.length + length)).toBe(
    run,
  );
  expect(url.slice(HTTPS_SCHEME.length + length)).toBe(target);
  // … and every backslash in the URL came from the run, none from the target.
  expect(countChar(url, BACKSLASH)).toBe(countChar(run, BACKSLASH));
}

/** Same-scheme bases for the invariance check (dialog host page, another viewer
 *  origin). See the header → "`SAME_SCHEME_BASES`". */
const SAME_SCHEME_BASES = [
  "https://next.readmoo.com/read/#/library",
  "https://moo.example/app/family",
];

/** Every row LITERALLY starting `https://` resolves identically with or without a
 *  base; `expectedChecked` pins the row count. See the file header. */
function expectAbsoluteRowsAreBaseInvariant(
  cases: readonly { url: string }[],
  expectedChecked: number,
): void {
  let checked = 0;
  for (const { url } of cases) {
    if (!url.startsWith(ABSOLUTE_HTTPS_PREFIX)) continue;
    let standalone: string;
    try {
      standalone = new URL(url).href;
    } catch {
      continue;
    }
    for (const base of SAME_SCHEME_BASES) {
      expect(new URL(url, base).href).toBe(standalone);
    }
    checked += 1;
  }
  // The filter must never silently match nothing — nor silently match fewer
  // rows than the caller believes it handed over.
  expect(checked).toBe(expectedChecked);
  expect(checked).toBeGreaterThan(0);
}

// The Worker's borrow-create cover whitelist (`400 INVALID_COVER_URL`): a beacon
// defence for `<img src>`. See the header → "isAllowedCoverUrl".
describe("isAllowedCoverUrl", () => {
  const cases: Array<{ name: string; url: string; expected: boolean }> = [
    {
      name: "an https cover on the .com CDN",
      url: "https://cdn.readmoo.com/cover/x.jpg",
      expected: true,
    },
    {
      name: "an https cover on the .tw CDN",
      url: "https://cdn.readmoo.tw/x.jpg",
      expected: true,
    },
    {
      // Over-blocking guard: full-`href` comparison must keep a nested path plus
      // query (real CDN covers carry both) byte-for-byte.
      name: "a nested cover path with a query string",
      url: "https://cdn.readmoo.tw/cover/aa/bb.jpg?v=3",
      expected: true,
    },
    {
      name: "an https cover on the apex domain",
      url: "https://readmoo.com/x.jpg",
      expected: true,
    },
    {
      // The URL parser normalises the default port away, so this is the same
      // origin CSP's host-source syntax matches.
      name: "an explicitly stated default port",
      url: "https://cdn.readmoo.com:443/x.jpg",
      expected: true,
    },
    {
      // Hostname comparison is case-sensitive, but the parser lower-cases the
      // host before `isReadmooCoverHost` ever sees it.
      name: "an upper-case cover host",
      url: "https://CDN.READMOO.COM/x.jpg",
      expected: true,
    },
    {
      name: "plain HTTP on an allowed host",
      url: "http://cdn.readmoo.com/x.jpg",
      expected: false,
    },
    {
      name: "a non-default port on an allowed host",
      url: "https://cdn.readmoo.com:8443/x.jpg",
      expected: false,
    },
    {
      name: "a non-HTTP scheme on an allowed host",
      url: "ftp://cdn.readmoo.com/x.jpg",
      expected: false,
    },
    {
      name: "an inline data: image",
      url: "data:image/png;base64,AAAA",
      expected: false,
    },
    {
      name: "a javascript: URL",
      url: "javascript:alert(1)",
      expected: false,
    },
    { name: "an unparseable string", url: "not-a-url", expected: false },
    { name: "an empty string", url: "", expected: false },
    {
      // No base URL is supplied, so this does not parse at all.
      name: "a protocol-relative URL",
      url: "//cdn.readmoo.com/x.jpg",
      expected: false,
    },
    // Four base-sensitive rows (a scheme with no `//`), confirmed exploitable; the
    // fifth is accepted. See the header → "Base-sensitive rows (cover matrix)".
    {
      name: "a bare scheme with no // and dot-segments",
      url: "https:cdn.readmoo.com/../../x.jpg",
      expected: false,
    },
    {
      name: "a bare scheme with a single slash",
      url: "https:/cdn.readmoo.com/x.jpg",
      expected: false,
    },
    {
      name: "a bare scheme with a single backslash",
      url: "https:\\cdn.readmoo.com/x.jpg",
      expected: false,
    },
    {
      // The scheme is matched case-insensitively on both sides, so upper-case
      // buys the attacker nothing — but only because the check normalises.
      name: "an upper-case bare scheme with no //",
      url: "HTTPS:cdn.readmoo.com/x.jpg",
      expected: false,
    },
    {
      // A PAIR of backslashes is absolute in every context, so it is accepted.
      // See the header → "Doubled backslash".
      name: "a bare scheme with a doubled backslash (equivalent to //)",
      url: "https:\\\\cdn.readmoo.com/x.jpg",
      expected: true,
    },
    {
      // Tripwire for widening `startsWith("https://")` into `includes("//")`: `//`
      // only in the PATH. See the header → "`//`-widening tripwire".
      name: "a single-slash scheme whose path happens to contain //",
      url: "https:/cdn.readmoo.com//x.jpg",
      expected: false,
    },
    {
      // Everything before the `@` is userinfo — the real host is evil.com.
      name: "an allowed host smuggled into the userinfo segment",
      url: "https://cdn.readmoo.com@evil.com/x.jpg",
      expected: false,
    },
    {
      name: "a bare userinfo segment on a foreign host",
      url: "https://user@evil.com/x.jpg",
      expected: false,
    },
    {
      name: "a look-alike that only suffixes a cover domain",
      url: "https://readmoo.com.evil.com/x.jpg",
      expected: false,
    },
    {
      name: "a look-alike that only prefixes a cover domain",
      url: "https://evilreadmoo.com/x.jpg",
      expected: false,
    },
    {
      // Fail-closed: the trailing-dot FQDN form keeps its own dot as the final
      // character, so the `.readmoo.com` boundary check does not match it.
      name: "the trailing-dot FQDN form of an allowed host",
      url: "https://cdn.readmoo.com./x.jpg",
      expected: false,
    },
  ];

  for (const { name, url, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isAllowedCoverUrl(url)).toBe(expected);
    });
  }

  it("accepts every declared cover domain at its apex and on a subdomain", () => {
    expect(READMOO_COVER_DOMAINS.length).toBeGreaterThan(0);
    for (const domain of READMOO_COVER_DOMAINS) {
      expect(isAllowedCoverUrl(`https://${domain}/cover.jpg`)).toBe(true);
      expect(isAllowedCoverUrl(`https://cdn.${domain}/cover.jpg`)).toBe(true);
    }
  });

  // Executable WHY for the base-sensitive rows: two PREMISE assertions, then the
  // contract. See the header → "Base-sensitive rows (cover matrix)".
  it("rejects a cover URL that changes host once a rendering page supplies the base", () => {
    // The document the extension dialog is injected into.
    const readmooPage = "https://next.readmoo.com/read/#/library";
    const hostile = "https:cdn.readmoo.com/../../x.jpg";

    // Validated standalone, the string looks like an ordinary CDN cover.
    expect(new URL(hostile).href).toBe("https://cdn.readmoo.com/x.jpg");
    // Rendered inside the Readmoo page, the very same string is an
    // authenticated same-site GET on the viewer's own Readmoo session.
    expect(new URL(hostile, readmooPage).href).toBe(
      "https://next.readmoo.com/x.jpg",
    );

    expect(isAllowedCoverUrl(hostile)).toBe(false);
  });

  // Executable form of the `//` tripwire row, so it cannot decay. See the header
  // → "`//`-widening tripwire".
  it("rejects a base-sensitive cover URL whose path contains a literal //", () => {
    const readmooPage = "https://next.readmoo.com/read/#/library";
    const hostile = "https:/cdn.readmoo.com//x.jpg";

    // The `//` is there — in the path, not after the scheme.
    expect(hostile).toContain("//");
    expect(hostile.startsWith(ABSOLUTE_HTTPS_PREFIX)).toBe(false);

    // One slash after the scheme, so a same-scheme base still wins the host.
    expect(new URL(hostile).href).toBe("https://cdn.readmoo.com//x.jpg");
    expect(new URL(hostile, readmooPage).href).toBe(
      "https://next.readmoo.com/cdn.readmoo.com//x.jpg",
    );

    expect(isAllowedCoverUrl(hostile)).toBe(false);
  });

  const coverRunTarget = "cdn.readmoo.com/x.jpg";

  it("enumerates every slash/backslash run up to the boundary", () => {
    const runCases = separatorRunCases(coverRunTarget);

    // The table below is exhaustive, not sampled: if the generator ever stops
    // producing all 31 distinct runs, the boundary is no longer pinned.
    expect(runCases).toHaveLength(SEPARATOR_RUN_COUNT);
    expect(new Set(runCases.map((c) => c.url)).size).toBe(SEPARATOR_RUN_COUNT);
  });

  // Boundary table over the separator run that follows `https:` — see
  // `separatorRunCases` for what the boundary is and why both sides matter.
  for (const runCase of separatorRunCases(coverRunTarget)) {
    it(`returns ${runCase.expected} for a scheme followed by ${spellRun(runCase.run)}`, () => {
      expectRunEncoding(runCase, coverRunTarget);
      expect(isAllowedCoverUrl(runCase.url)).toBe(runCase.expected);
    });
  }

  // 12 `https://` rows in the matrix above, plus the separator runs beginning
  // `//` — see the helper for why the exhaustive table has to be in here too.
  it("resolves every absolute https row identically with and without a base", () => {
    expectAbsoluteRowsAreBaseInvariant(
      [...cases, ...separatorRunCases(coverRunTarget)],
      12 + FAST_PATH_RUN_COUNT,
    );
  });
});

// The per-book `<a href>` whitelist; the ONLY exhaustive matrix for it, never to be
// replaced by "these two agree". See the header → "isAllowedBookUrl".
describe("isAllowedBookUrl", () => {
  const cases: Array<{ name: string; url: string; expected: boolean }> = [
    {
      // The real shape of every legitimate value — see the anti-drift test below.
      name: "the apex book-detail URL the scraper builds",
      url: "https://readmoo.com/book/210001",
      expected: true,
    },
    {
      name: "a link on the new web-app host",
      url: "https://next.readmoo.com/book/210001",
      expected: true,
    },
    {
      // Over-blocking guard: the hash route `readmooAppUrl` builds must survive
      // full-`href` comparison byte-for-byte.
      name: "a hash-route link into the web app",
      url: "https://next.readmoo.com/read/#/library",
      expected: true,
    },
    {
      // Same guard for the query + fragment combination.
      name: "a book link carrying a query string and a fragment",
      url: "https://readmoo.com/book/210001?utm=1#p2",
      expected: true,
    },
    {
      name: "a link on the legacy web-app host",
      url: "https://read.readmoo.com/book/210001",
      expected: true,
    },
    {
      name: "a link on the .tw registrable domain",
      url: "https://readmoo.tw/book/210001",
      expected: true,
    },
    {
      // The URL parser normalises the default port away, so this is the same
      // origin as the bare apex form.
      name: "an explicitly stated default port",
      url: "https://readmoo.com:443/book/210001",
      expected: true,
    },
    {
      // Hostname comparison is case-sensitive, but the parser lower-cases the
      // host before the domain check ever sees it.
      name: "an upper-case host",
      url: "https://READMOO.COM/book/210001",
      expected: true,
    },
    {
      name: "plain HTTP on an allowed domain",
      url: "http://readmoo.com/book/210001",
      expected: false,
    },
    {
      name: "a non-default port on an allowed domain",
      url: "https://readmoo.com:8443/book/210001",
      expected: false,
    },
    {
      // The payload an `<a href>` whitelist exists to stop: without the scheme
      // check this would execute in the page on click.
      name: "a javascript: URL",
      url: "javascript:alert(1)",
      expected: false,
    },
    {
      name: "an inline data: document",
      url: "data:text/html;base64,PHNjcmlwdD4=",
      expected: false,
    },
    { name: "an unparseable string", url: "not-a-url", expected: false },
    { name: "an empty string", url: "", expected: false },
    {
      // No base URL is supplied, so this does not parse at all.
      name: "a protocol-relative URL",
      url: "//readmoo.com/book/210001",
      expected: false,
    },
    // Base-sensitive rows (same-origin `<a href>` exploit), confirmed exploitable.
    // See the header → "isAllowedBookUrl" → "Base-sensitive book rows".
    {
      name: "a bare scheme with no // and dot-segments",
      url: "https:readmoo.com/../../public/x#invite=moo-x",
      expected: false,
    },
    {
      name: "a bare scheme with a single slash",
      url: "https:/readmoo.com/book/210001",
      expected: false,
    },
    {
      name: "a bare scheme with a single backslash",
      url: "https:\\readmoo.com/book/210001",
      expected: false,
    },
    {
      // The scheme is matched case-insensitively on both sides, so upper-case
      // buys the attacker nothing — but only because the check normalises.
      name: "an upper-case bare scheme with no //",
      url: "HTTPS:readmoo.com/book/210001",
      expected: false,
    },
    {
      // A PAIR of backslashes is absolute in every context, so it is accepted.
      // See the header → "Doubled backslash".
      name: "a bare scheme with a doubled backslash (equivalent to //)",
      url: "https:\\\\readmoo.com/book/210001",
      expected: true,
    },
    {
      // Tripwire for widening `startsWith("https://")` into `includes("//")`: `//`
      // only in the PATH. See the header → "`//`-widening tripwire".
      name: "a single-slash scheme whose path happens to contain //",
      url: "https:/readmoo.com//x",
      expected: false,
    },
    {
      // Everything before the `@` is userinfo — the real host is evil.com.
      name: "an allowed domain smuggled into the userinfo segment",
      url: "https://readmoo.com@evil.com/book/210001",
      expected: false,
    },
    {
      name: "a look-alike that only suffixes an allowed domain",
      url: "https://readmoo.com.evil.com/book/210001",
      expected: false,
    },
    {
      name: "a look-alike that only prefixes an allowed domain",
      url: "https://evilreadmoo.com/book/210001",
      expected: false,
    },
    {
      // Fail-closed: the trailing-dot FQDN form keeps its own dot as the final
      // character, so the `.readmoo.com` boundary check does not match it.
      name: "the trailing-dot FQDN form of an allowed host",
      url: "https://readmoo.com./book/210001",
      expected: false,
    },
  ];

  for (const { name, url, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isAllowedBookUrl(url)).toBe(expected);
    });
  }

  it("accepts every declared domain at its apex and on a subdomain", () => {
    expect(READMOO_COVER_DOMAINS.length).toBeGreaterThan(0);
    for (const domain of READMOO_COVER_DOMAINS) {
      expect(isAllowedBookUrl(`https://${domain}/book/210001`)).toBe(true);
      expect(isAllowedBookUrl(`https://next.${domain}/book/210001`)).toBe(true);
    }
  });

  // Rebuilding on `isReadmooHost` (web-app hosts only) would blank every APEX book
  // link. See the header → "isAllowedBookUrl" → "Apex trap".
  it("accepts the apex book URL that isReadmooHost rejects", () => {
    const bookUrl = "https://readmoo.com/book/210001";

    expect(isAllowedBookUrl(bookUrl)).toBe(true);
    expect(isReadmooHost(new URL(bookUrl).hostname)).toBe(false);
  });

  // Executable WHY, reconstructing the observed exploit: two PREMISE assertions,
  // then the contract. See the header → "Base-sensitive rows (cover matrix)".
  it("rejects a book URL that changes origin once a rendering page supplies the base", () => {
    // Any PWA/extension page the link is rendered into; only its origin matters.
    const viewerPage = "https://moo.example/app/family";
    const hostile = "https:readmoo.com/../../public/x#invite=moo-x";

    // Validated standalone, the string looks like an ordinary Readmoo link.
    expect(new URL(hostile).href).toBe(
      "https://readmoo.com/public/x#invite=moo-x",
    );
    // Clicked inside the viewer's own page it never leaves that origin — it
    // drives the app's own invite route, under the user's real URL bar.
    expect(new URL(hostile, viewerPage).href).toBe(
      "https://moo.example/public/x#invite=moo-x",
    );

    expect(isAllowedBookUrl(hostile)).toBe(false);
  });

  // Executable form of the `//` tripwire row, so it cannot decay. See the header
  // → "`//`-widening tripwire".
  it("rejects a base-sensitive book URL whose path contains a literal //", () => {
    const viewerPage = "https://moo.example/app/family";
    const hostile = "https:/readmoo.com//x";

    // The `//` is there — in the path, not after the scheme.
    expect(hostile).toContain("//");
    expect(hostile.startsWith(ABSOLUTE_HTTPS_PREFIX)).toBe(false);

    // One slash after the scheme, so a same-scheme base still wins the host:
    // clicked in the viewer's own page, the link never leaves that origin.
    expect(new URL(hostile).href).toBe("https://readmoo.com//x");
    expect(new URL(hostile, viewerPage).href).toBe(
      "https://moo.example/readmoo.com//x",
    );

    expect(isAllowedBookUrl(hostile)).toBe(false);
  });

  const bookRunTarget = "readmoo.com/book/210001";

  it("enumerates every slash/backslash run up to the boundary", () => {
    const runCases = separatorRunCases(bookRunTarget);

    // The table below is exhaustive, not sampled: if the generator ever stops
    // producing all 31 distinct runs, the boundary is no longer pinned.
    expect(runCases).toHaveLength(SEPARATOR_RUN_COUNT);
    expect(new Set(runCases.map((c) => c.url)).size).toBe(SEPARATOR_RUN_COUNT);
  });

  // Boundary table over the separator run that follows `https:` — see
  // `separatorRunCases` for what the boundary is and why both sides matter.
  for (const runCase of separatorRunCases(bookRunTarget)) {
    it(`returns ${runCase.expected} for a scheme followed by ${spellRun(runCase.run)}`, () => {
      expectRunEncoding(runCase, bookRunTarget);
      expect(isAllowedBookUrl(runCase.url)).toBe(runCase.expected);
    });
  }

  // 13 `https://` rows in the matrix above, plus the separator runs beginning
  // `//` — see the helper for why the exhaustive table has to be in here too.
  it("resolves every absolute https row identically with and without a base", () => {
    expectAbsoluteRowsAreBaseInvariant(
      [...cases, ...separatorRunCases(bookRunTarget)],
      13 + FAST_PATH_RUN_COUNT,
    );
  });
});

// A non-string from the backend must neither throw (white screen) nor blank valid
// links; both assertions per row matter. See the header → "Non-string input".
describe("isAllowedCoverUrl / isAllowedBookUrl on non-string input", () => {
  interface NonStringCase {
    name: string;
    /** Deliberately `unknown` — that it is not a `string` is the whole point. */
    value: unknown;
  }

  const predicates = [
    {
      name: "isAllowedCoverUrl",
      predicate: isAllowedCoverUrl,
      allowedUrl: "https://cdn.readmoo.com/x.jpg",
    },
    {
      name: "isAllowedBookUrl",
      predicate: isAllowedBookUrl,
      allowedUrl: "https://readmoo.com/book/210001",
    },
  ];

  /** Arrays that `String()` turns into an allowed URL, so they REACH the string
   *  method (the ones that threw). See the header → "Non-string input". */
  function reachingCases(allowedUrl: string): NonStringCase[] {
    return [
      {
        name: "a single-element array wrapping an allowed URL",
        value: [allowedUrl],
      },
      {
        name: "a nested array wrapping an allowed URL",
        value: [[allowedUrl]],
      },
    ];
  }

  // Non-strings no URL parser accepts: the fail-closed half (refused, never
  // propagated, never fatal).
  const unparseableCases: NonStringCase[] = [
    { name: "a plain object", value: {} },
    { name: "a number", value: 42 },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ];

  for (const { name: predicateName, predicate, allowedUrl } of predicates) {
    for (const { name, value } of reachingCases(allowedUrl)) {
      it(`${predicateName} returns true for ${name} instead of throwing`, () => {
        // Premise: this is the shape that gets past the parse and the scheme /
        // port / host checks, i.e. the only kind that reaches the fast path.
        expect(typeof value).not.toBe("string");
        expect(String(value)).toBe(allowedUrl);
        expect(new URL(String(value)).href).toBe(allowedUrl);

        expect(() => predicate(value as string)).not.toThrow();
        // The verdict the core gave before the fast path existed. Asserted so
        // a guard written as an early `return false` cannot pass as a fix.
        expect(predicate(value as string)).toBe(true);
      });
    }

    for (const { name, value } of unparseableCases) {
      it(`${predicateName} returns false for ${name} instead of throwing`, () => {
        expect(() => predicate(value as string)).not.toThrow();
        expect(predicate(value as string)).toBe(false);
      });
    }
  }
});

describe("READMOO_COVER_DOMAINS", () => {
  it("lists the registrable domains that may serve book covers", () => {
    expect(READMOO_COVER_DOMAINS).toEqual(["readmoo.com", "readmoo.tw"]);
  });

  it("holds registrable domains only, never a host pattern or a URL", () => {
    for (const domain of READMOO_COVER_DOMAINS) {
      // The PWA CSP derives `https://{d}` / `https://*.{d}` from these, so each
      // must be a bare registrable domain (pwa/tests/unit/cspHeaders.test.ts).
      expect(domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(domain).not.toContain("*");
      expect(domain).not.toContain("/");
    }
  });
});

describe("isLibraryUrl", () => {
  const cases: Array<{
    name: string;
    hostname: string;
    pathname: string;
    hash: string;
    expected: boolean;
  }> = [
    {
      name: "the new site's library page under /read/",
      hostname: READMOO_HOST_NEXT,
      pathname: "/read/",
      hash: LIBRARY_HASH,
      expected: true,
    },
    {
      name: "the new site's app root without a trailing slash",
      hostname: READMOO_HOST_NEXT,
      pathname: "/read",
      hash: LIBRARY_HASH,
      expected: true,
    },
    {
      name: "the new site's root path (the app only lives under /read)",
      hostname: READMOO_HOST_NEXT,
      pathname: "/",
      hash: LIBRARY_HASH,
      expected: false,
    },
    {
      name: "a new-site path that merely prefixes /read",
      hostname: READMOO_HOST_NEXT,
      pathname: "/reading",
      hash: LIBRARY_HASH,
      expected: false,
    },
    {
      name: "the legacy site's library page at the root",
      hostname: READMOO_HOST_LEGACY,
      pathname: "/",
      hash: LIBRARY_HASH,
      expected: true,
    },
    {
      name: "the legacy site's library page under any other pathname",
      hostname: READMOO_HOST_LEGACY,
      pathname: "/whatever/",
      hash: LIBRARY_HASH,
      expected: true,
    },
    {
      name: "a #/library sub-route",
      hostname: READMOO_HOST_NEXT,
      pathname: "/read/",
      hash: `${LIBRARY_HASH}/all`,
      expected: true,
    },
    {
      name: "a sibling hash route that only prefixes #/library",
      hostname: READMOO_HOST_NEXT,
      pathname: "/read/",
      hash: "#/librarything",
      expected: false,
    },
    {
      name: "another hash route on a supported host",
      hostname: READMOO_HOST_LEGACY,
      pathname: "/",
      hash: ME_HASH,
      expected: false,
    },
    {
      name: "a look-alike host serving the same path and hash",
      hostname: "next.readmoo.com.evil.com",
      pathname: "/read/",
      hash: LIBRARY_HASH,
      expected: false,
    },
    {
      name: "a non-readmoo host",
      hostname: "localhost",
      pathname: "/",
      hash: LIBRARY_HASH,
      expected: false,
    },
  ];

  for (const { name, hostname, pathname, hash, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isLibraryUrl(hostname, pathname, hash)).toBe(expected);
    });
  }
});

describe("readmooAppUrl", () => {
  const cases: Array<{
    name: string;
    hostname: string;
    hash: string;
    expected: string;
  }> = [
    {
      name: "prefixes the new host's library route with /read",
      hostname: READMOO_HOST_NEXT,
      hash: LIBRARY_HASH,
      expected: "https://next.readmoo.com/read/#/library",
    },
    {
      name: "prefixes the new host's profile route with /read",
      hostname: READMOO_HOST_NEXT,
      hash: ME_HASH,
      expected: "https://next.readmoo.com/read/#/me",
    },
    {
      name: "serves the legacy host's library route from the root",
      hostname: READMOO_HOST_LEGACY,
      hash: LIBRARY_HASH,
      expected: "https://read.readmoo.com/#/library",
    },
    {
      name: "serves the legacy host's profile route from the root",
      hostname: READMOO_HOST_LEGACY,
      hash: ME_HASH,
      expected: "https://read.readmoo.com/#/me",
    },
    {
      name: "falls back to the legacy host for an unknown hostname",
      hostname: "localhost",
      hash: LIBRARY_HASH,
      expected: "https://read.readmoo.com/#/library",
    },
    {
      name: "never echoes a look-alike hostname back into the URL",
      hostname: "next.readmoo.com.evil.com",
      hash: LIBRARY_HASH,
      expected: "https://read.readmoo.com/#/library",
    },
    {
      name: "falls back to the legacy host for an empty hostname",
      hostname: "",
      hash: LIBRARY_HASH,
      expected: "https://read.readmoo.com/#/library",
    },
  ];

  for (const { name, hostname, hash, expected } of cases) {
    it(name, () => {
      expect(readmooAppUrl(hostname, hash)).toBe(expected);
    });
  }

  it("produces a URL whose host is always a supported Readmoo host", () => {
    for (const hostname of ["", "localhost", "evil.com", READMOO_HOST_NEXT]) {
      const url = new URL(readmooAppUrl(hostname, LIBRARY_HASH));
      expect(isReadmooHost(url.hostname)).toBe(true);
    }
  });
});

describe("READMOO_HOSTS", () => {
  it("lists both supported hosts with the new site first", () => {
    expect(READMOO_HOSTS).toEqual([READMOO_HOST_NEXT, READMOO_HOST_LEGACY]);
  });

  it("derives origins from the host list", () => {
    expect(READMOO_ORIGINS).toEqual([
      "https://next.readmoo.com",
      "https://read.readmoo.com",
    ]);
  });

  it("derives manifest match patterns from the host list", () => {
    expect(READMOO_MATCH_PATTERNS).toEqual([
      "https://next.readmoo.com/*",
      "https://read.readmoo.com/*",
    ]);
  });
});
