import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { READMOO_COVER_DOMAINS } from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Anti-drift guard for the `img-src` directive in `pwa/public/_headers`.
 *
 * `docs/architecture.md` (已接受的殘餘風險) names this CSP as the READ-SIDE
 * neutraliser for the one residual the write-side cover-URL whitelist cannot
 * reach: a `public:{share_token}` snapshot minted BEFORE `sanitizeCoverUrl`
 * existed keeps its foreign cover URL until the shelf is refreshed — for a
 * permanent snapshot, indefinitely. The browser never issues that request only
 * because `img-src` is narrowed to the Readmoo cover domains, which makes this
 * header a load-bearing mitigation rather than defence in depth.
 *
 * The header is a hand-written mirror of `READMOO_COVER_DOMAINS`
 * (`shared/src/config/readmoo.ts`) — the same list the Worker's
 * `isAllowedCoverUrl` accepts at the write boundary — and nothing linked the
 * two. Adding a cover domain to `shared/` would let the Worker store covers the
 * PWA then silently refuses to render; dropping one here would re-open the
 * tracking-beacon path with every suite still green. This test is that link: it
 * reads the header off disk and compares it against the shared constant.
 *
 * Reading the file is reading production — Cloudflare Pages serves `_headers`
 * verbatim from `public/`, so no build step can rewrite it in between.
 */

const HEADERS_PATH = resolve(__dirname, "../../public/_headers");

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
 * Pull the `img-src` source list out of a Cloudflare Pages `_headers` file.
 *
 * Throws instead of returning an empty list on anything unexpected: a silently
 * empty result would make every assertion below pass vacuously, which is the
 * exact failure mode this file exists to prevent.
 */
function parseImgSrcSources(headersText: string): string[] {
  const cspValues = [
    ...headersText.matchAll(
      /^[ \t]*content-security-policy[ \t]*:[ \t]*(.+)$/gim,
    ),
  ].map((match) => match[1].trim());
  if (cspValues.length !== 1) {
    throw new Error(
      `expected exactly one Content-Security-Policy header, found ${cspValues.length}`,
    );
  }

  const imgSrcDirectives = cspValues[0]
    .split(";")
    .map((directive) => directive.trim())
    .filter(
      (directive) => directive.split(/\s+/)[0].toLowerCase() === "img-src",
    );
  if (imgSrcDirectives.length !== 1) {
    throw new Error(
      `expected exactly one img-src directive, found ${imgSrcDirectives.length}`,
    );
  }

  // Drop the directive name; what is left is the source list.
  return imgSrcDirectives[0].split(/\s+/).slice(1);
}

const httpsSourcesOf = (sources: string[]): string[] =>
  sources.filter((source) => source.startsWith("https://")).sort();

const imgSrcSources = parseImgSrcSources(readFileSync(HEADERS_PATH, "utf-8"));

describe("pwa/public/_headers img-src", () => {
  it("allows exactly the shared READMOO_COVER_DOMAINS as https sources", () => {
    // Guards a vacuous pass: an emptied shared list would otherwise match an
    // img-src that lists no host at all.
    expect(EXPECTED_HTTPS_SOURCES.length).toBeGreaterThan(0);

    expect(
      httpsSourcesOf(imgSrcSources),
      "img-src has drifted from READMOO_COVER_DOMAINS (shared/src/config/readmoo.ts). A domain the Worker stores but the CSP omits renders as a broken cover; a domain the CSP allows but the Worker rejects only widens the read-side whitelist. List `https://<domain>` and `https://*.<domain>` for every cover domain in pwa/public/_headers.",
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
    // Deliberately redundant with the case above: `img-src 'self' https: data:`
    // is the exact value this branch replaced, and it allows a cover fetch to
    // ANY https host — the whole residual the CSP is supposed to neutralise.
    expect(imgSrcSources).not.toContain("https:");
  });
});

describe("parseImgSrcSources", () => {
  /** Minimal `_headers` file carrying one CSP with the given directives. */
  const headersFile = (csp: string): string =>
    `/*\n  Content-Security-Policy: ${csp}\n  X-Frame-Options: DENY\n`;

  const withImgSrc = (sources: string[]): string =>
    headersFile(
      `default-src 'self'; img-src ${sources.join(" ")}; font-src 'self'`,
    );

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
    expect(httpsSourcesOf(parseImgSrcSources(withImgSrc(sources)))).not.toEqual(
      [...EXPECTED_HTTPS_SOURCES].sort(),
    );
  });

  it("still sees the bare https: wildcard the PWA used to ship", () => {
    const legacy = parseImgSrcSources(
      headersFile("img-src 'self' https: data:"),
    );

    expect(legacy).toContain("https:");
    expect(httpsSourcesOf(legacy)).toEqual([]);
  });

  it("reads the directive from a CRLF file", () => {
    // A Windows checkout may hand us CRLF; the extractor must not swallow the
    // trailing `\r` into the last source.
    expect(
      parseImgSrcSources(
        "/*\r\n  Content-Security-Policy: img-src 'self' data:\r\n",
      ),
    ).toEqual(["'self'", "data:"]);
  });

  it.each([
    ["the file declares no CSP header", "/*\n  X-Frame-Options: DENY\n"],
    [
      "the CSP declares no img-src directive",
      headersFile("default-src 'self'; script-src 'self'"),
    ],
    [
      "two CSP headers make the effective policy ambiguous",
      `${headersFile("img-src 'self'")}\n/admin/*\n  Content-Security-Policy: img-src 'none'\n`,
    ],
  ])("throws when %s", (_what, text) => {
    expect(() => parseImgSrcSources(text)).toThrow();
  });
});
