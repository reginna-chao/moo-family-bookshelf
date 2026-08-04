import { describe, it, expect } from "vitest";
import {
  LIBRARY_HASH,
  ME_HASH,
  READMOO_HOSTS,
  READMOO_HOST_LEGACY,
  READMOO_HOST_NEXT,
  READMOO_MATCH_PATTERNS,
  READMOO_ORIGINS,
  isLibraryUrl,
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
