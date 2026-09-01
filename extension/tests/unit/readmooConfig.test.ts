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

/**
 * A single backslash, built from its character code so that no escaping layer —
 * a TypeScript string literal, Prettier, a diff viewer, a reviewer's eye — can
 * turn one into two. The single/double distinction decides the verdict in the
 * tables below (`https:\readmoo.com/x` is rejected, `https:\\readmoo.com/x` is
 * allowed), and it is exactly the kind of detail an escaping slip inverts
 * silently, so every generated case is also read back and asserted on how many
 * backslashes actually survived into it.
 */
const BACKSLASH = String.fromCharCode(92);

/** The scheme prefix every separator-run case is built on. */
const HTTPS_SCHEME = "https:";

/**
 * The canonical absolute spelling that production's fast path early-accepts.
 * Deliberately re-stated here rather than imported: `ABSOLUTE_HTTPS_PREFIX` is
 * file-local in `shared/src/config/readmoo.ts` on purpose, and this subset is
 * the SUBJECT of the tests below, not a rule they inherit.
 */
const ABSOLUTE_HTTPS_PREFIX = "https://";

/** Longest separator run the exhaustive table enumerates. */
const MAX_SEPARATOR_RUN = 4;

/** 2^0 + 2^1 + 2^2 + 2^3 + 2^4 — every run up to {@link MAX_SEPARATOR_RUN}. */
const SEPARATOR_RUN_COUNT = 31;

/**
 * How many of those runs begin `//` — 1 of length 2, 2 of length 3, 4 of
 * length 4. Exactly the runs whose URL LITERALLY starts `https://`, so exactly
 * the subset production's fast path early-accepts without re-proving
 * base-invariance. That makes them the rows
 * {@link expectAbsoluteRowsAreBaseInvariant} most needs to see.
 */
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

/**
 * Exhaustive table over the one property these shapes' verdict turns on: how
 * many slash-ish characters follow `https:`. WHATWG treats `\` like `/` for a
 * special scheme, so the run is counted over BOTH characters, and the boundary
 * sits between 1 and 2:
 *
 *   - 0 or 1 → base-SENSITIVE. Against a same-scheme base the parser drops into
 *     "relative" state and takes the host from the BASE, so the string means
 *     something else in the document it is rendered into ⇒ must be rejected.
 *   - 2 or more → base-INDEPENDENT. The host is read from the string with or
 *     without a base ⇒ a genuine absolute Readmoo URL ⇒ must be allowed.
 *
 * Enumerating all 31 combinations pins WHERE that boundary is rather than
 * sampling either side of it, and it exercises both production paths at once:
 * the {@link FAST_PATH_RUN_COUNT} runs beginning `//` hit the fast path's
 * early-accept — `///` and `//\` among them, because that test is a PREFIX
 * test and not an "exactly two" one — while `\\`, `/\`, `\/` and `\//` miss it
 * and must still be allowed by the full base-invariance comparison behind it.
 * A fast path that started REJECTING on a miss, or one promoted from an
 * early-accept to the criterion, turns the second group red.
 */
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

/**
 * Escaping tripwire, asserted per case: reads the separator run back off the
 * exact string that is about to be handed to the predicate. Without it, a slip
 * anywhere between `String.fromCharCode(92)` and the final URL would quietly
 * move a case to the other side of the boundary while the suite stayed green.
 */
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

/**
 * Bases the invariance property is resolved against. The scheme must MATCH the
 * input's: WHATWG only enters "relative" state for a same-scheme base, so a
 * base on any other scheme could never disprove invariance. The first is the
 * document the extension dialog is injected into; the second stands for any
 * other viewer origin (the PWA renders the same stored values).
 */
const SAME_SCHEME_BASES = [
  "https://next.readmoo.com/read/#/library",
  "https://moo.example/app/family",
];

/**
 * The property production's fast path rests on: a string that LITERALLY begins
 * `https://` resolves to the same `href` with or without a base document.
 *
 * Why this needs pinning in CI now, and did not before. Until the fast path
 * existed, the core PROVED base-invariance for every accepted string by
 * comparing the standalone parse against a parse with a base — a runtime that
 * resolved some `https://` string differently against a base would have been
 * rejected, fail-closed, without anyone noticing the deviation. The fast path
 * skips that comparison for this subset, which promotes the WHATWG guarantee
 * from a convenience to a load-bearing assumption: inside the subset a parser
 * deviation is now accepted silently. This test is what would notice.
 *
 * Driven by the caller's own rows, never a fresh whitelist, so every `https://`
 * row anyone adds there is covered, once the expected count is bumped. NOT
 * automatic, and deliberately so: `expectedChecked` is hard-coded at each call
 * site, so a newly added row turns this test red until someone updates that
 * number — the friction described under `expectedChecked` below is the price of
 * the hole it closes. Unparseable inputs are skipped, matching production: the
 * core reaches the prefix test only after `new URL(url)` has already succeeded.
 *
 * Callers pass BOTH their hand-written matrix and the exhaustive separator
 * table, because the hand-written matrix alone spells only the canonical
 * `https://` form. The table is what covers the six NON-canonical spellings the
 * fast path also early-accepts — `https:///…`, `https://\…`, `https:////…`,
 * `https:///\…`, `https://\/…` and `https://\\…` — and those are precisely the
 * shapes most likely to diverge between parsers. The table's own rows cannot
 * stand in for this: they assert a `true` verdict against a hand-derived
 * `expected`, so if an engine ever made one of those forms base-SENSITIVE, the
 * fast path would return true anyway and the table would stay green. This is
 * the check that would not.
 *
 * `expectedChecked` pins how many rows actually survived the filter. A bare
 * "> 0" would let the separator spread be deleted at a call site — the
 * hand-written rows would keep passing while the fast-path shapes went back to
 * being uncovered, which is the exact hole this test exists to close.
 */
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

/**
 * `isAllowedCoverUrl` is the Worker's write-time whitelist for
 * `bookCoverUrl` on borrow-create (worker/src/routes/borrow.ts →
 * `400 INVALID_COVER_URL`): a cover URL is rendered into an `<img src>` on
 * every family member's screen, so an attacker-chosen host would leak each
 * viewer's IP / UA to a third party. Everything below is that beacon defence.
 */
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
      // Guards the base-sensitivity check below against over-blocking: it
      // compares full `href`s, so a nested path plus a query string has to
      // survive resolution byte-for-byte. Real CDN covers carry both.
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
    /**
     * The four REJECTED rows below share ONE attack primitive: a scheme with
     * no `//` (the fifth is an accepted boundary case, documented in place).
     * This predicate validates the STRING, but the browser resolves that same
     * string against the document it is rendered INTO. WHATWG reads these
     * forms through "special authority ignore slashes" state when NO base is
     * given — host = `cdn.readmoo.com`, so the scheme / port / host checks
     * above all pass — and through "relative" state when the base carries the
     * same scheme, where the host silently becomes the BASE's instead.
     *
     * On a cover the payoff needs no click and no user mistake. The dialog is
     * injected INTO a Readmoo page, so the base is
     * `https://next.readmoo.com/read/…` and the `<img src>` fires an
     * authenticated same-site GET at an attacker-chosen Readmoo path the
     * moment the card renders, carrying the viewer's Readmoo cookies; in the
     * PWA the same string lands on the PWA's own origin instead. No CSP
     * `img-src` catches either one, because the origin it resolves to is the
     * rendering page's OWN — which any usable policy already allows. No other
     * rejected row in this table lands there: the foreign-host rows
     * (`evilreadmoo.com`, the userinfo smuggle) are third-party by name, and
     * the rows that do spell out a first-party host (plain HTTP, a non-default
     * port, a non-HTTP scheme, the trailing-dot FQDN) each resolve to an
     * origin DISTINCT from the rendering page's, which a whitelist or a CSP
     * can still name and refuse.
     *
     * Confirmed exploitable: each row returned TRUE until the core started
     * comparing the standalone parse against a parse with a base. Ordinary
     * absolute URLs resolve identically either way, so the accepted rows above
     * pin that the fix does not over-block.
     */
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
      /**
       * Boundary companion to the single-backslash row above, and the reason
       * this predicate tests base-SENSITIVITY rather than blocking backslashes
       * outright. WHATWG's "relative slash state" treats a `\` in a special
       * scheme exactly like `/`, so a PAIR of them reaches "special authority
       * ignore slashes" state and the host is read from the STRING — with or
       * without a base. Verified identical in Node's parser and in whatwg-url
       * (what jsdom and the browsers implement), so this really is an absolute
       * cover URL in every rendering context, and accepting it is correct.
       *
       * Kept as an executable note so the single-backslash row above is not
       * misread as "backslashes are rejected". Rejecting this shape anyway
       * would be a defensible extra tightening — it is just not what the
       * base-sensitivity fix does, and this row is what would flag the change.
       */
      name: "a bare scheme with a doubled backslash (equivalent to //)",
      url: "https:\\\\cdn.readmoo.com/x.jpg",
      expected: true,
    },
    {
      /**
       * Regression tripwire for the ONE widening the production fast path
       * invites: relaxing its `url.startsWith("https://")` early-accept into
       * `url.includes("//")`, or any other "there is a `//` in here somewhere"
       * test. This string DOES carry a literal `//` — in the PATH — while only
       * ONE slash follows the scheme, so it is base-SENSITIVE and must stay
       * rejected. The widening would early-accept it and this row alone turns
       * red — but NOT because it is the only rejected row containing a `//`.
       * Several others here carry one: plain HTTP, the `ftp:` scheme, a
       * non-default port, the protocol-relative form, the userinfo smuggle,
       * the two look-alike hosts, the trailing-dot FQDN. Every one of them is
       * refused earlier — by the parse itself, or by the scheme / port / host
       * checks that run BEFORE the fast path is consulted — so the widening
       * never gets to see them. This row is the only rejected one that BOTH
       * reaches the fast path and contains a literal `//`, which is what makes
       * it the tripwire.
       *
       * The criterion is base-INVARIANCE, not the presence or absence of `//`.
       * POSITION carries the whole argument, in both directions: `//` in the
       * path proves nothing (this row), and `https:\\cdn.readmoo.com/x.jpg`
       * above is allowed with no `//` anywhere in it. See the executable
       * statement of this row further down the describe.
       */
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

  /**
   * Executable statement of WHY the four base-sensitive rows above must be
   * rejected, rather than four bare `expected: false` entries a later reader
   * could mistake for over-caution and delete.
   *
   * The first two assertions are the PREMISE — they pin the parser disagreement
   * the attack rests on, so if a future engine ever stopped treating this shape
   * as base-sensitive, this test says so instead of quietly passing. The last
   * one is the production contract: whatever the parser does, the whitelist
   * must refuse a string whose meaning depends on where it is rendered.
   */
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

  /**
   * Executable form of the `//`-widening tripwire row above, so the row cannot
   * decay: an edit that dropped the `//` from that URL would leave the row
   * passing while no longer guarding anything. These assertions pin the two
   * facts that make it a tripwire at all — the literal `//` is present, and the
   * string is still NOT of the shape the fast path may early-accept — next to
   * the parser disagreement that forces the rejection.
   */
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

/**
 * `isAllowedBookUrl` is the whitelist for the per-book detail link
 * (`readmooUrl`), which the Extension and the PWA render as a clickable
 * `<a href>` and the Worker sanitises on both the books write paths and the
 * family-bookshelf / public-snapshot read paths.
 *
 * Different trust boundary from the cover matrix above: a cover is an
 * `<img src>` that fires a request on RENDER, while a book link needs a click.
 * That lowers the rate but not the severity — the click happens precisely when
 * the user believes they are opening Readmoo, so an off-domain value is a
 * phishing / arbitrary-redirect lure served under a legitimate book title, and
 * the destination host learns the viewer's IP and User-Agent. It does not learn
 * the referer: every render site pairs the href with `rel="noopener
 * noreferrer"`, and `noreferrer` suppresses the Referer header outright — that
 * attribute is load-bearing, so dropping it would widen this exposure. No CSP
 * substitutes for the whitelist either: `img-src` governs image loads and says
 * nothing about navigation.
 *
 * This is the ONLY exhaustive matrix for the rule, so it is written full even
 * though `isAllowedCoverUrl` shares the same core today. The two are separately
 * tightenable by design, so neither matrix may be replaced by "these two agree".
 */
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
      // Guards the base-sensitivity check below against over-blocking: it
      // compares full `href`s, so the hash route has to survive resolution
      // byte-for-byte. This is the shape `readmooAppUrl` builds.
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
    /**
     * Same primitive as the cover matrix's base-sensitive rows — a scheme with
     * no `//` — restated here because the two exports are separately
     * tightenable and neither matrix may lean on "these two agree".
     *
     * What the string means depends on WHERE it is rendered: WHATWG resolves
     * these forms through "special authority ignore slashes" state with no
     * base (host = `readmoo.com`, so every check above passes) and through
     * "relative" state against a same-scheme base (host = the BASE's). So the
     * whitelist certifies "this points at Readmoo" while the `<a href>` in the
     * page points at the VIEWER's own origin.
     *
     * That is the observed exploit, and it is worse here than a plain
     * off-domain phishing link: the target is same-origin, so the viewer sees
     * their own trusted URL bar. The reported chain sent a PWA reader to the
     * PWA's own `/public/x#invite=moo-x`, which the SPA fallback answers by
     * clearing the stored session and pre-filling the attacker's sync code —
     * i.e. it drives the app's OWN join flow, something no third-party
     * destination could do. `rel="noopener noreferrer"` is no help against it
     * either: that hardens where a link LANDS, not which origin it resolves to.
     *
     * Confirmed exploitable: each row returned TRUE until the core started
     * comparing the standalone parse against a parse with a base.
     */
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
      // Boundary companion to the single-backslash row above; see the cover
      // matrix's copy for the full reasoning. A PAIR of backslashes reaches
      // "special authority ignore slashes" state, so the host comes from the
      // STRING with or without a base — an absolute Readmoo link in every
      // rendering context, hence accepted. Present so the row above is not
      // misread as "backslashes are rejected".
      name: "a bare scheme with a doubled backslash (equivalent to //)",
      url: "https:\\\\readmoo.com/book/210001",
      expected: true,
    },
    {
      /**
       * The `//`-widening tripwire, restated for this export because the two
       * are separately tightenable and neither matrix may lean on "these two
       * agree". Relaxing the production fast path's
       * `url.startsWith("https://")` early-accept into `url.includes("//")` —
       * or any other "has a `//` somewhere" test — would early-accept this
       * string, which carries a literal `//` in its PATH while only ONE slash
       * follows the scheme, i.e. is base-SENSITIVE and must stay rejected.
       *
       * The criterion is base-INVARIANCE, not the presence or absence of `//`.
       * POSITION decides it, in both directions: a `//` in the path proves
       * nothing (this row), and the doubled-backslash row above is allowed
       * while containing no `//` at all. It alone catches the widening, but
       * NOT because it is the only rejected row carrying a `//` — plain HTTP,
       * a non-default port, the protocol-relative form, the userinfo smuggle,
       * the two look-alike hosts and the trailing-dot FQDN all carry one too.
       * Each of those is refused earlier, by the parse itself or by the
       * scheme / port / host checks that run BEFORE the fast path, so this is
       * the only rejected row that BOTH reaches the fast path and contains a
       * literal `//`.
       */
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

  /**
   * Anti-drift tripwire for the trap this whitelist is one refactor away from:
   * `isReadmooHost` looks like the obvious predicate to reuse, but its
   * exact-match list holds only the two WEB-APP hosts (next. / read.), while
   * every legitimate book link lives on the APEX — `readmooUrl` is built as
   * `${READMOO_BOOK_BASE}${bookId}` with
   * `READMOO_BOOK_BASE = "https://readmoo.com/book/"`
   * (extension/src/content/scraper.ts:31). Rebuilding `isAllowedBookUrl` on
   * `isReadmooHost` would therefore blank EVERY real book link — a total
   * feature outage that no hostile-URL test would catch, because all the
   * hostile cases would still (correctly) return false.
   */
  it("accepts the apex book URL that isReadmooHost rejects", () => {
    const bookUrl = "https://readmoo.com/book/210001";

    expect(isAllowedBookUrl(bookUrl)).toBe(true);
    expect(isReadmooHost(new URL(bookUrl).hostname)).toBe(false);
  });

  /**
   * Executable statement of WHY the base-sensitive rows above must be rejected,
   * reconstructing the observed exploit end to end so the rows cannot later be
   * mistaken for over-caution and deleted.
   *
   * The first two assertions are the PREMISE — they pin the parser
   * disagreement the attack rests on, so if a future engine stopped treating
   * this shape as base-sensitive, this test says so instead of quietly
   * passing. The third is the production contract: a string whose meaning
   * depends on the rendering document can never be whitelisted, because the
   * whitelist is applied to the string and the browser is not.
   */
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

  /**
   * Executable form of the `//`-widening tripwire row above, so the row cannot
   * decay: an edit that dropped the `//` from that URL would leave the row
   * passing while no longer guarding anything. These assertions pin the two
   * facts that make it a tripwire — the literal `//` is present, and the string
   * is still NOT of the shape the fast path may early-accept — right next to
   * the parser disagreement that forces the rejection.
   */
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

/**
 * Runtime robustness of both whitelists against a NON-STRING argument — the
 * one thing their `url: string` parameter cannot promise.
 *
 * Why a `string` parameter still needs runtime rows. The value arrives from the
 * BACKEND, and nothing on the way narrows its type:
 *   - Both API clients read the `{ data, error }` envelope through a bare cast
 *     (`extension/src/api/client.ts`, `pwa/src/api/client.ts`), so the declared
 *     shape is an assumption about the server, not a checked fact.
 *   - The server is user-configurable. A sync code's `@host` segment points a
 *     whole family at a self-hosted Worker, which may predate any of these
 *     checks or be modified outright.
 *   - `coverUrl` is DELIBERATELY excluded from the runtime text coercion that
 *     guards its sibling fields. That exclusion is argued under the
 *     `Not covered here, deliberately:` heading of `shared/src/api/safeText.ts`
 *     — a block title rather than a line number on purpose, because the
 *     numbers this reference used to carry went stale inside a single PR. The
 *     argument there has TWO parts and both are load-bearing: these fields
 *     only render into an `<img src>` attribute, which the DOM string-coerces,
 *     AND they run through the Readmoo URL whitelist first, which guards its
 *     OWN input type. The second part is not a property of that module at all
 *     — it is a property of the code under test HERE, and this describe block
 *     is what enforces it. `safeText.ts` says so outright: if the whitelist
 *     ever drops that guard, the exclusion stops being safe and these fields
 *     have to be coerced there instead. `sanitizeBookText` accordingly coerces
 *     `readmooUrl` but not `coverUrl`, and `sanitizeFamilyBookshelfText` does
 *     not touch it either, so on the family-bookshelf path a non-string
 *     `coverUrl` reaches the render layer verbatim.
 * A JSON body whose `coverUrl` is `["https://cdn.readmoo.com/x.jpg"]` therefore
 * arrives at `safeCoverUrl` → `isAllowedCoverUrl` (extension/src/dialog/
 * BookCard.tsx:113 and its three twins) as an ARRAY. The DOM half of that
 * argument still holds for such a value; the whitelist half is precisely what
 * the rows below buy, because a string method on an array throws and neither
 * app mounts an ErrorBoundary — so a throw there is a permanent white screen
 * rather than a blank cover.
 *
 * `isAllowedBookUrl` is asserted on the same inputs even though its own field
 * IS coerced today: the two exports are separate trust boundaries over ONE
 * file-local core, so the guard has to hold on both sides of that split, and
 * the coercion that currently protects `readmooUrl` is a different module's
 * decision that may change without anyone revisiting this one.
 *
 * What regressed, and why the guard looks deletable. Until the fast path landed
 * the core only ever fed this parameter to `new URL(...)`, which coerces its
 * argument with `String()` — an array of one URL string parsed fine and the
 * base-invariance comparison answered `true`. `url.startsWith(...)` is the
 * FIRST string method the core has ever called on it, and a string method on an
 * array throws. The `typeof` guard in front of it therefore reads like dead
 * weight next to a `string` parameter — this block is what turns red when
 * someone tidies it away.
 *
 * Both assertions per row are load-bearing. `not.toThrow()` alone would also be
 * satisfied by a guard written as an early `return false`, which does not crash
 * but silently blanks every legitimate cover and book link on that path — so
 * each row also pins the verdict the core returned BEFORE the fast path
 * existed. Inputs are cast at the call site; the production signature stays
 * strict, and the cast is the honest spelling of what the network hands over.
 */
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

  /**
   * The shapes that actually REACH the string method, and so the ones that
   * threw: `String()` on a one-element array is that element, recursively, so
   * both of these coerce to a genuine allowed Readmoo URL while being no string
   * at all. Every check ahead of the fast path — the parse, the scheme, the
   * port, the host — passes on the coerced value, which is exactly why the
   * input survives that far.
   */
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

  /**
   * Non-strings that `String()` turns into something no URL parser accepts, so
   * `new URL(value)` throws inside the core's own try/catch and the fast path
   * is never reached. They pin the fail-closed half: a malformed field is
   * refused, never propagated and never fatal.
   */
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
      // The PWA CSP derives `https://{d}` and `https://*.{d}` from these
      // entries (see pwa/tests/unit/cspHeaders.test.ts), which only works while
      // each entry is a bare registrable domain.
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
