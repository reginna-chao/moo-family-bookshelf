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
});

describe("READMOO_COVER_DOMAINS", () => {
  it("lists the registrable domains that may serve book covers", () => {
    expect(READMOO_COVER_DOMAINS).toEqual(["readmoo.com", "readmoo.tw"]);
  });

  it("holds registrable domains only, never a host pattern or a URL", () => {
    for (const domain of READMOO_COVER_DOMAINS) {
      // The PWA CSP derives `https://{d}` and `https://*.{d}` from these
      // entries (see pwa/tests/unit/cspImgSrc.test.ts), which only works while
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
