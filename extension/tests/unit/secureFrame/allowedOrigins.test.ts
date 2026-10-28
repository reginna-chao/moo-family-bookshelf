import { describe, it, expect } from "vitest";
import manifest from "../../../public/manifest.json";
import { isAllowedParentOrigin } from "../../../src/secureFrame/allowedOrigins";

/**
 * Which parent origins may hand the secure frame its MessagePort (#363). The Readmoo cases use the
 * REAL `web_accessible_resources[].matches` of `public/manifest.json`, so a pattern edited there is
 * checked here. `E2E_PATTERN` is the pattern `scripts/build-e2e.ts` adds to the E2E build only.
 * The extension's own origin is always allowed (the Dialog dev page); nothing else is.
 */

const MANIFEST_MATCHES: readonly string[] =
  manifest.web_accessible_resources.flatMap((entry) => entry.matches);
const E2E_PATTERN = "http://localhost:*/*";
const SELF = "chrome-extension://mock-extension-id";

describe("isAllowedParentOrigin", () => {
  it("reads both Readmoo hosts from the shipped manifest", () => {
    expect(MANIFEST_MATCHES).toEqual(
      expect.arrayContaining([
        "https://next.readmoo.com/*",
        "https://read.readmoo.com/*",
      ]),
    );
  });

  it.each([
    ["https://next.readmoo.com", true],
    ["https://read.readmoo.com", true],
    ["https://next.readmoo.com:443", true],
    ["https://NEXT.READMOO.COM", true],
    ["http://next.readmoo.com", false],
    ["https://next.readmoo.com:8443", false],
    ["https://readmoo.com", false],
    ["https://www.readmoo.com", false],
    ["https://next.readmoo.com.evil.com", false],
    ["https://evilnext.readmoo.com", false],
    ["https://next.readmoo.com@evil.com", false],
    ["https://next.readmoo.com/", false],
    ["https://next.readmoo.com/library", false],
    ["https://evil.com", false],
    ["http://localhost:5173", false],
  ])("Readmoo manifest: %s → %s", (origin, expected) => {
    expect(isAllowedParentOrigin(origin, MANIFEST_MATCHES, SELF)).toBe(
      expected,
    );
  });

  it.each([
    ["http://localhost:5173", true],
    ["http://localhost:8787", true],
    ["http://localhost", true],
    ["http://localhost:80", true],
    ["https://localhost:5173", false],
    ["http://127.0.0.1:5173", false],
    ["http://localhost.evil.com:5173", false],
  ])("E2E localhost pattern (any port): %s → %s", (origin, expected) => {
    expect(isAllowedParentOrigin(origin, [E2E_PATTERN], SELF)).toBe(expected);
  });

  it.each([
    ["http://localhost:8787", true],
    ["http://localhost:8788", false],
    ["http://localhost", false],
  ])(
    "a pattern with an explicit port allows only that port: %s → %s",
    (origin, expected) => {
      expect(
        isAllowedParentOrigin(origin, ["http://localhost:8787/*"], SELF),
      ).toBe(expected);
    },
  );

  it("allows the extension's own origin with no manifest pattern", () => {
    expect(isAllowedParentOrigin(SELF, [], SELF)).toBe(true);
    const mozSelf = "moz-extension://5f0c1d2e-aaaa-bbbb-cccc-0123456789ab";
    expect(isAllowedParentOrigin(mozSelf, MANIFEST_MATCHES, mozSelf)).toBe(
      true,
    );
  });

  it.each([
    "chrome-extension://another-extension-id",
    "moz-extension://5f0c1d2e-0000-0000-0000-000000000000",
    "file://",
    "data:",
  ])("rejects a non-web origin that is not the frame's own: %s", (origin) => {
    expect(
      isAllowedParentOrigin(origin, [...MANIFEST_MATCHES, E2E_PATTERN], SELF),
    ).toBe(false);
  });

  it.each(["*", "null", ""])(
    "rejects the sentinel origin %j even when it equals selfOrigin",
    (origin) => {
      expect(isAllowedParentOrigin(origin, MANIFEST_MATCHES, SELF)).toBe(false);
      expect(isAllowedParentOrigin(origin, MANIFEST_MATCHES, origin)).toBe(
        false,
      );
    },
  );

  it.each([
    "<all_urls>",
    "*://*/*",
    "https://*/*",
    "https://*.readmoo.com/*",
    "*://next.readmoo.com/*",
    "https://next.readmoo.com",
    "",
  ])("never treats the pattern %j as allowing a Readmoo origin", (pattern) => {
    expect(
      isAllowedParentOrigin("https://next.readmoo.com", [pattern], SELF),
    ).toBe(false);
    expect(isAllowedParentOrigin("https://evil.com", [pattern], SELF)).toBe(
      false,
    );
  });

  it("rejects every web origin when the manifest lists no pattern", () => {
    expect(isAllowedParentOrigin("https://next.readmoo.com", [], SELF)).toBe(
      false,
    );
  });
});
