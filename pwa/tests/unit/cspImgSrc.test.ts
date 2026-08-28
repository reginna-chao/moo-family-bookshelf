import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { READMOO_COVER_DOMAINS } from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Drift tripwire between the PWA's render-time defence and the Worker's
 * write-time one.
 *
 * A borrow request carries a `bookCoverUrl` that every family member's browser
 * later fetches through an `<img src>`. A URL on an attacker-chosen host would
 * therefore leak each viewer's IP / UA to a third party — a tracking beacon
 * planted by one family member against the rest. Two independent layers stop it:
 *
 *   1. WRITE time — the Worker refuses a non-Readmoo cover URL at the API
 *      boundary (`isAllowedCoverUrl` in worker/src/routes/borrow.ts →
 *      `400 INVALID_COVER_URL`).
 *   2. RENDER time — the CSP `img-src` in pwa/public/_headers refuses to load
 *      one that got stored anyway (older rows, a self-hosted Worker, a future
 *      hole in the handler).
 *
 * Layer 2 is a STATIC text file: nothing imports it, no typecheck reaches it,
 * so it can silently fall out of step with `READMOO_COVER_DOMAINS` and weaken
 * to a single-layer defence without a single test turning red. This file is
 * what turns red — it derives the expected source list FROM the shared
 * constant, so adding a cover domain without updating `_headers` fails here,
 * and so does the reverse.
 */

const HEADERS_PATH = resolve(__dirname, "../../public/_headers");

/**
 * Parse the Cloudflare Pages `_headers` file and return the headers declared
 * under one path pattern.
 *
 * Format: an unindented line opens a block naming the path pattern it applies
 * to; the indented `Name: value` lines below it are that block's headers.
 * Reading the block explicitly (rather than grepping the whole file) is what
 * proves the CSP is attached to the catch-all route and not to some subpath.
 */
function headersForPath(pathPattern: string): Map<string, string> {
  const raw = readFileSync(HEADERS_PATH, "utf-8");
  const headers = new Map<string, string>();
  let insideBlock = false;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      insideBlock = line.trim() === pathPattern;
      continue;
    }
    if (!insideBlock) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }

  return headers;
}

/** Source list of one CSP directive, e.g. `img-src` → `["'self'", "data:"]`. */
function directiveSources(policy: string, directive: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === directive || part.startsWith(`${directive} `));
  if (found === undefined) {
    throw new Error(`CSP has no \`${directive}\` directive: ${policy}`);
  }
  return found.split(/\s+/).slice(1);
}

/** The policy served on every route, or a load-time failure naming why not. */
function readCatchAllPolicy(): string {
  const value = headersForPath("/*").get("Content-Security-Policy");
  if (value === undefined) {
    throw new Error(
      "pwa/public/_headers declares no Content-Security-Policy under the `/*` block",
    );
  }
  return value;
}

const policy = readCatchAllPolicy();

describe("PWA CSP img-src", () => {
  it("serves a Content-Security-Policy on every route", () => {
    expect(policy).toContain("img-src");
  });

  it("allows exactly the shared Readmoo cover domains, plus self and data:", () => {
    // Vacuous-pass guard: an empty shared list would make any img-src pass.
    expect(READMOO_COVER_DOMAINS.length).toBeGreaterThan(0);

    const expected = [
      "'self'",
      "data:",
      ...READMOO_COVER_DOMAINS.flatMap((domain) => [
        `https://${domain}`,
        `https://*.${domain}`,
      ]),
    ];

    expect(
      [...directiveSources(policy, "img-src")].sort(),
      "pwa/public/_headers has drifted from READMOO_COVER_DOMAINS in shared/src/config/readmoo.ts. The CSP img-src is the PWA's render-time half of the cover-URL beacon defence whose write-time half is worker/src/routes/borrow.ts (INVALID_COVER_URL) — both must name the same domains. Fix by editing the img-src list in _headers to match the shared constant.",
    ).toEqual([...expected].sort());
  });

  it("never widens img-src to a bare scheme or a wildcard host", () => {
    // `https:` (or `*`) would allow ANY origin and silently re-open the beacon
    // hole the domain list exists to close — the exact regression to catch.
    const sources = directiveSources(policy, "img-src");
    for (const forbidden of ["https:", "http:", "*", "'unsafe-inline'"]) {
      expect(sources).not.toContain(forbidden);
    }
  });

  it("parses each directive in isolation", () => {
    // Guards the parser itself: `connect-src` legitimately carries the bare
    // `https:` scheme source, so a parser that bled directives together would
    // make the check above pass on a policy that never restricted images.
    expect(directiveSources(policy, "connect-src")).toContain("https:");
    expect(directiveSources(policy, "object-src")).toEqual(["'none'"]);
  });
});
