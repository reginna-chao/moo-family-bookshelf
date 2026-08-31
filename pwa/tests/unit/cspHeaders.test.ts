import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { READMOO_COVER_DOMAINS } from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Anti-drift guard for the CSP served out of `pwa/public/_headers`, and for its
 * `img-src` directive in particular.
 *
 * A cover URL pointing at an attacker-chosen host leaks every viewer's IP / UA
 * to a third party — a tracking beacon one family member can plant against the
 * rest, since a borrow request's `bookCoverUrl` is rendered straight into an
 * `<img src>`. Two independent layers stop it:
 *
 *   1. WRITE time — the Worker refuses a non-Readmoo cover URL at the API
 *      boundary (`isAllowedCoverUrl` in worker/src/routes/borrow.ts →
 *      `400 INVALID_COVER_URL`), and scrubs stored ones on the way out of
 *      `GET /api/public/:shareToken`
 *      (`worker/tests/integration/publicShelf.test.ts` → "coverUrl read-side
 *      scrub").
 *   2. RENDER time — the `img-src` directive pinned here refuses to load one
 *      that got stored anyway: rows written before the whitelist existed, a
 *      self-hosted Worker, a future hole in the handler.
 *
 * Layer 1 demotes layer 2 from load-bearing mitigation to DEFENCE IN DEPTH —
 * still worth pinning, because `_headers` is honoured only on hosts that parse
 * it (Cloudflare Pages does; a self-hosted PWA on GitHub Pages / S3 / nginx
 * ships no `img-src` whitelist at all), and it is the last line for any cover
 * URL reaching the app from a surface the Worker scrub does not cover.
 *
 * The catch: layer 2 is a STATIC text file. Nothing imports it, no typecheck
 * reaches it, so it can fall out of step with `READMOO_COVER_DOMAINS`
 * (`shared/src/config/readmoo.ts` — the same list `isAllowedCoverUrl` accepts
 * at the write boundary) and weaken to a single layer without one suite turning
 * red. Adding a cover domain to `shared/` would let the Worker store covers the
 * PWA then silently refuses to render; dropping one here would re-open the
 * beacon path. This file is the missing link: it reads the header off disk and
 * derives everything it must contain from the shared constant.
 *
 * Reading the file is reading production — Cloudflare Pages serves `_headers`
 * verbatim from `public/`, so no build step can rewrite it in between.
 */

const HEADERS_PATH = resolve(__dirname, "../../public/_headers");

/** The `_headers` path block whose headers apply to every route the PWA serves. */
const CATCH_ALL_PATH = "/*";

/** Sources each cover domain must contribute: the apex plus any subdomain. */
const EXPECTED_HTTPS_SOURCES = READMOO_COVER_DOMAINS.flatMap((domain) => [
  `https://${domain}`,
  `https://*.${domain}`,
]);

/**
 * The non-host sources `img-src` may carry, and why each is there:
 *   `'self'` — same-origin assets shipped with the PWA (icons, PWA artwork);
 *   `data:`  — the select-arrow background in `pwa/src/index.css` is a data URI.
 * Anything beyond these two widens the whitelist and must be a deliberate edit
 * here, not something that arrives unnoticed with an unrelated header change.
 */
const EXPECTED_NON_HTTPS_SOURCES = ["'self'", "data:"];

/**
 * Every value declared for `headerName` under one path block of a Cloudflare
 * Pages `_headers` file.
 *
 * Format: an unindented line opens a block naming the path pattern it applies
 * to; the indented `Name: value` lines below it are that block's headers.
 * Reading the block explicitly (rather than grepping the whole file) is what
 * proves the CSP is attached to the catch-all route and not to some subpath.
 *
 * Returns a list rather than the last match so the caller can reject a
 * duplicate declaration instead of silently reading one of two conflicting
 * policies.
 */
function headerValues(
  headersText: string,
  pathPattern: string,
  headerName: string,
): string[] {
  const wanted = headerName.toLowerCase();
  const values: string[] = [];
  let insideBlock = false;

  for (const line of headersText.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!/^[ \t]/.test(line)) {
      insideBlock = line.trim() === pathPattern;
      continue;
    }
    if (!insideBlock) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== wanted) continue;
    values.push(line.slice(separator + 1).trim());
  }

  return values;
}

/**
 * The CSP served on every route.
 *
 * Throws instead of returning an empty policy on anything unexpected: a
 * silently empty result would make every assertion below pass vacuously, which
 * is the exact failure mode this file exists to prevent.
 */
function catchAllPolicy(headersText: string): string {
  const values = headerValues(
    headersText,
    CATCH_ALL_PATH,
    "Content-Security-Policy",
  );
  if (values.length !== 1) {
    throw new Error(
      `expected exactly one Content-Security-Policy header under \`${CATCH_ALL_PATH}\`, found ${values.length}`,
    );
  }
  return values[0];
}

/**
 * Source list of one CSP directive, e.g. `img-src` → `["'self'", "data:"]`.
 *
 * Directives are read in isolation, and a duplicate is rejected rather than
 * resolved to the first match: either would let an ambiguous policy answer as
 * if it were unambiguous.
 */
function directiveSources(policy: string, directive: string): string[] {
  const matches = policy
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/)[0].toLowerCase() === directive);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one \`${directive}\` directive, found ${matches.length}: ${policy}`,
    );
  }
  // Drop the directive name; what is left is the source list.
  return matches[0].split(/\s+/).slice(1);
}

const imgSrcSourcesOf = (headersText: string): string[] =>
  directiveSources(catchAllPolicy(headersText), "img-src");

/**
 * How many Content-Security-Policy headers the file declares in total, across
 * every path block.
 *
 * `catchAllPolicy` deliberately reads one block, so on its own it cannot see a
 * SECOND policy attached to a narrower pattern — which would override the
 * catch-all one for those routes and could weaken `img-src` there while every
 * assertion below stayed green.
 */
const cspDeclarationCount = (headersText: string): number =>
  [...headersText.matchAll(/^[ \t]*content-security-policy[ \t]*:/gim)].length;

const httpsSourcesOf = (sources: string[]): string[] =>
  sources.filter((source) => source.startsWith("https://")).sort();

const headersText = readFileSync(HEADERS_PATH, "utf-8");
const policy = catchAllPolicy(headersText);
const imgSrcSources = directiveSources(policy, "img-src");

describe("pwa/public/_headers CSP", () => {
  it("serves a Content-Security-Policy on every route", () => {
    // `catchAllPolicy` already throws when the `/*` block declares none; this
    // pins the directive under test as part of that catch-all policy.
    expect(policy).toContain("img-src");
  });

  it("declares that policy under no other path block", () => {
    expect(
      cspDeclarationCount(headersText),
      "pwa/public/_headers declares more than one Content-Security-Policy. A second one under a narrower path pattern overrides the catch-all policy for those routes, so the img-src assertions below stop describing what the browser actually enforces there. Keep the policy in the `/*` block only.",
    ).toBe(1);
  });

  it("allows exactly the shared READMOO_COVER_DOMAINS as https sources", () => {
    // Guards a vacuous pass: an emptied shared list would otherwise match an
    // img-src that lists no host at all.
    expect(EXPECTED_HTTPS_SOURCES.length).toBeGreaterThan(0);

    expect(
      httpsSourcesOf(imgSrcSources),
      "img-src has drifted from READMOO_COVER_DOMAINS (shared/src/config/readmoo.ts). The CSP img-src is the PWA's render-time half of the cover-URL beacon defence whose write-time half is worker/src/routes/borrow.ts (INVALID_COVER_URL) — both must name the same domains. A domain the Worker stores but the CSP omits renders as a broken cover; a domain the CSP allows but the Worker rejects only widens the read-side whitelist. List `https://<domain>` and `https://*.<domain>` for every cover domain in pwa/public/_headers.",
    ).toEqual([...EXPECTED_HTTPS_SOURCES].sort());
  });

  it.each(EXPECTED_NON_HTTPS_SOURCES)("keeps %s in img-src", (source) => {
    expect(imgSrcSources).toContain(source);
  });

  it("carries no source beyond 'self', data: and the cover domains", () => {
    const nonHttpsSources = imgSrcSources
      .filter((source) => !source.startsWith("https://"))
      .sort();

    expect(
      nonHttpsSources,
      "img-src gained a source outside the documented set. Every addition widens what a stale poisoned snapshot can make the browser fetch — if the addition is intended, extend EXPECTED_NON_HTTPS_SOURCES above with the reason it is needed.",
    ).toEqual([...EXPECTED_NON_HTTPS_SOURCES].sort());
  });

  it("does not fall back to the bare https: scheme source", () => {
    // Deliberately redundant with the cases above: `img-src 'self' https: data:`
    // is the exact value this whitelist replaced, and it allows a cover fetch to
    // ANY https host — i.e. no depth left behind the Worker's read-side scrub.
    expect(imgSrcSources).not.toContain("https:");
  });

  it("never widens img-src to a bare scheme or a wildcard host", () => {
    for (const forbidden of ["https:", "http:", "*", "'unsafe-inline'"]) {
      expect(imgSrcSources).not.toContain(forbidden);
    }
  });

  it("parses each directive in isolation", () => {
    // Guards the parser against its neighbours: `connect-src` legitimately
    // carries the bare `https:` scheme source, so a parser that bled directives
    // together would make the checks above pass on a policy that never
    // restricted images.
    expect(directiveSources(policy, "connect-src")).toContain("https:");
    expect(directiveSources(policy, "object-src")).toEqual(["'none'"]);
  });
});

describe("_headers parsing", () => {
  /** Minimal `_headers` file carrying one catch-all CSP with the given directives. */
  const headersFile = (csp: string): string =>
    `${CATCH_ALL_PATH}\n  Content-Security-Policy: ${csp}\n  X-Frame-Options: DENY\n`;

  const withImgSrc = (sources: string[]): string =>
    headersFile(
      `default-src 'self'; img-src ${sources.join(" ")}; font-src 'self'`,
    );

  /** Catch-all policy plus a second, narrower one — legal, but a weakening. */
  const WITH_SUBPATH_POLICY = `${headersFile("img-src 'self'")}/admin/*\n  Content-Security-Policy: img-src 'none'\n`;

  // The falsifiability probes: the assertions above only mean something if the
  // extractor actually reports drift, so each direction of drift is fed through
  // it in memory. `pwa/public/_headers` on disk is never modified.
  it.each([
    {
      what: "a cover domain is missing from the header",
      sources: [
        ...EXPECTED_NON_HTTPS_SOURCES,
        ...EXPECTED_HTTPS_SOURCES.slice(0, -1),
      ],
    },
    {
      what: "the header allows a host outside the shared list",
      sources: [
        ...EXPECTED_NON_HTTPS_SOURCES,
        ...EXPECTED_HTTPS_SOURCES,
        "https://cdn.evil.example",
      ],
    },
  ])("reports drift when $what", ({ sources }) => {
    expect(httpsSourcesOf(imgSrcSourcesOf(withImgSrc(sources)))).not.toEqual(
      [...EXPECTED_HTTPS_SOURCES].sort(),
    );
  });

  it("still sees the bare https: wildcard the PWA used to ship", () => {
    const legacy = imgSrcSourcesOf(headersFile("img-src 'self' https: data:"));

    expect(legacy).toContain("https:");
    expect(httpsSourcesOf(legacy)).toEqual([]);
  });

  it("reads the directive from a CRLF file", () => {
    // A Windows checkout may hand us CRLF; the extractor must not swallow the
    // trailing `\r` into the last source.
    expect(
      imgSrcSourcesOf(
        "/*\r\n  Content-Security-Policy: img-src 'self' data:\r\n",
      ),
    ).toEqual(["'self'", "data:"]);
  });

  it("reads only the block it was asked for", () => {
    // A CSP scoped to a subpath must not be mistaken for the catch-all one:
    // that is what makes "serves a CSP on every route" a real assertion.
    expect(imgSrcSourcesOf(WITH_SUBPATH_POLICY)).toEqual(["'self'"]);
  });

  it("still counts a CSP declared under a narrower block", () => {
    // The other half of the case above: block scoping must not make a second
    // policy invisible, only keep it out of the catch-all reading.
    expect(cspDeclarationCount(WITH_SUBPATH_POLICY)).toBe(2);
  });

  it.each([
    [
      "the catch-all block declares no CSP header",
      `${CATCH_ALL_PATH}\n  X-Frame-Options: DENY\n`,
    ],
    [
      "the file declares no catch-all block at all",
      "/admin/*\n  Content-Security-Policy: img-src 'self'\n",
    ],
    [
      "the CSP declares no img-src directive",
      headersFile("default-src 'self'; script-src 'self'"),
    ],
    [
      "two CSP headers make the effective policy ambiguous",
      `${CATCH_ALL_PATH}\n  Content-Security-Policy: img-src 'self'\n  Content-Security-Policy: img-src 'none'\n`,
    ],
    [
      "two img-src directives make the effective source list ambiguous",
      headersFile("img-src 'self'; img-src 'none'"),
    ],
  ])("throws when %s", (_what, text) => {
    expect(() => imgSrcSourcesOf(text)).toThrow();
  });
});
