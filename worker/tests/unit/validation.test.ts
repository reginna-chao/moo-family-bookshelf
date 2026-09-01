import { describe, it, expect } from "vitest";
import {
  isJsonObject,
  sanitizeCoverUrl,
  sanitizeDisplayName,
  sanitizeReadmooUrl,
  validateDisplayName,
} from "../../src/utils/validation";

describe("sanitizeDisplayName", () => {
  it("returns empty string for undefined/null", () => {
    expect(sanitizeDisplayName(undefined)).toBe("");
    expect(sanitizeDisplayName(null)).toBe("");
  });

  it("returns null for non-string", () => {
    expect(sanitizeDisplayName(123)).toBeNull();
    expect(sanitizeDisplayName(true)).toBeNull();
  });

  it("trims whitespace", () => {
    expect(sanitizeDisplayName("  小明  ")).toBe("小明");
  });

  it("returns null when exceeds 20 chars", () => {
    expect(sanitizeDisplayName("a".repeat(21))).toBeNull();
  });

  it("allows exactly 20 chars", () => {
    expect(sanitizeDisplayName("a".repeat(20))).toBe("a".repeat(20));
  });

  it("strips zero-width characters", () => {
    expect(sanitizeDisplayName("小\u200B明")).toBe("小明");
    expect(sanitizeDisplayName("\uFEFF小明")).toBe("小明");
  });

  it("strips control characters", () => {
    expect(sanitizeDisplayName("小\u0000明")).toBe("小明");
    expect(sanitizeDisplayName("小\u001F明")).toBe("小明");
    expect(sanitizeDisplayName("小\u007F明")).toBe("小明");
  });

  it("strips directional override characters", () => {
    expect(sanitizeDisplayName("小\u202A明\u202E")).toBe("小明");
    expect(sanitizeDisplayName("\u2066小明\u2069")).toBe("小明");
  });

  it("allows normal CJK and emoji", () => {
    expect(sanitizeDisplayName("小明🎉")).toBe("小明🎉");
  });
});

describe("validateDisplayName", () => {
  it("returns null for undefined/null", () => {
    expect(validateDisplayName(undefined)).toBeNull();
    expect(validateDisplayName(null)).toBeNull();
  });

  it("allows empty string", () => {
    expect(validateDisplayName("")).toBe("");
  });

  it("strips unsafe unicode and trims", () => {
    expect(validateDisplayName("  小\u200B明  ")).toBe("小明");
  });

  it("checks length after stripping", () => {
    // 20 visible chars + zero-width chars should pass
    const name = "a".repeat(20) + "\u200B".repeat(5);
    expect(validateDisplayName(name)).toBe("a".repeat(20));
  });
});

/**
 * Base-sensitive URL forms — the bypass BOTH sanitizers below must blank.
 *
 * What the whitelist validates is a STRING; what a browser later resolves is
 * that same string against the base of the RENDERING document. WHATWG reads a
 * scheme with no `//` two different ways: standalone (no base) it goes through
 * "special authority ignore slashes" state and the host is the one spelled out
 * in the string — `readmoo.com`, which is exactly why the pre-fix whitelist let
 * these through — but against a base carrying the SAME scheme it goes through
 * "relative" state and the host becomes the BASE's host, i.e. the viewer's own
 * origin.
 *
 * The consequence differs per field, and the COVER side is the worse of the two:
 *
 * - `coverUrl` is rendered into an `<img src>`, so the request fires on RENDER,
 *   with no user action at all. In the Extension the rendering document is a
 *   Readmoo page, so it becomes a same-site GET to Readmoo carrying the
 *   victim's cookies; in the PWA it becomes a GET against the PWA's own origin.
 * - `readmooUrl` is rendered into an `<a href>` and needs a click, but the click
 *   lands the viewer on their OWN origin's `/public/x#invite=…` — a route the
 *   PWA answers by unconditionally clearing the stored session (`apiHost`
 *   included) and pre-filling the attacker's sync code.
 *
 * ONE table, asserted by BOTH describes below. `isAllowedCoverUrl` and
 * `isAllowedBookUrl` are separate trust boundaries but share a single
 * file-local core in `shared/src/config/readmoo.ts`, and this defect was in
 * that core — so a regression would surface on whichever boundary was left
 * unpinned. Keeping one table is also what stops the two from drifting.
 */
const BASE_SENSITIVE_URLS: ReadonlyArray<{ label: string; input: string }> = [
  {
    label: "a scheme with no slashes at all (the observed exploit shape)",
    input: "https:readmoo.com/../../public/x#invite=moo-x",
  },
  {
    label: "a scheme with a single slash",
    input: "https:/readmoo.com/y",
  },
  {
    // Exactly ONE backslash. WHATWG treats `\\` as equivalent to `//`, so the
    // two-backslash spelling really does mean readmoo.com with or without a
    // base and is deliberately still allowed — it is not a bypass.
    label: "a scheme with a single backslash",
    input: "https:\\readmoo.com/x",
  },
  {
    label: "a scheme with no slashes, spelled in uppercase",
    input: "HTTPS:readmoo.com/x",
  },
];

/**
 * Deliberately LEAN. The full URL matrix (schemes, ports, look-alike domains,
 * userinfo smuggling, non-string shapes) is pinned through `parseBooks` in
 * `tests/unit/putBooksAllowlist.test.ts`; duplicating it here would only make
 * two tables drift apart.
 *
 * What this suite adds is the EXPORT itself: `sanitizeCoverUrl` moved out of
 * `routes/user.ts` to become shared boundary logic, so `services/publicShelf.ts`
 * can re-sanitize every public snapshot it writes. A rename, a removal, or a
 * change to the keep/blank verdict now fails here rather than only inside one
 * caller's suite.
 */
describe("sanitizeCoverUrl", () => {
  it.each<{ label: string; input: string }>([
    { label: "the empty-string scraper placeholder", input: "" },
    {
      label: "a whitelisted Readmoo cover host, verbatim",
      input: "https://cdn.readmoo.com/cover/abc.jpg",
    },
  ])("keeps $label", ({ input }) => {
    expect(sanitizeCoverUrl(input)).toBe(input);
  });

  it.each<{ label: string; input: unknown }>([
    {
      label: "an attacker-controlled host",
      input: "https://evil.example.com/beacon.gif",
    },
    { label: "a non-string value", input: 123 },
    { label: "null", input: null },
    { label: "undefined (absent field)", input: undefined },
  ])("blanks $label", ({ input }) => {
    expect(sanitizeCoverUrl(input)).toBe("");
  });

  // The one URL row this otherwise-lean suite carries in full, because the
  // cover boundary is where a base-sensitive value does the MOST damage: an
  // `<img src>` fires on render with no click, so a stored value of this shape
  // beacons the viewer's own origin (Readmoo itself, with cookies, inside the
  // Extension) for every family member and every public-shelf visitor.
  // Mechanics and the shared-core reasoning: see BASE_SENSITIVE_URLS above.
  it.each(BASE_SENSITIVE_URLS)(
    "blanks $label, which resolves onto the viewer's own origin",
    ({ input }) => {
      expect(sanitizeCoverUrl(input)).toBe("");
    },
  );
});

/**
 * Deliberately FULLER than the `sanitizeCoverUrl` suite above, and that
 * asymmetry is on purpose: the cover matrix is pinned through `parseBooks` in
 * `tests/unit/putBooksAllowlist.test.ts`, whereas the book-link matrix lives
 * HERE — at the boundary helper all six of its call sites share (the three
 * books write paths, `buildSnapshot`, the family-bookshelf aggregation, and the
 * public snapshot read). The `parseBooks` suite pins only the WIRING for this
 * field, so there is still exactly one table per rule and nothing to drift.
 *
 * Why the field needs its own guard at all: `readmooUrl` is rendered as a
 * clickable `<a href>`, so an off-whitelist value is a phishing /
 * arbitrary-redirect lure served under a legitimate book title — a different
 * failure mode from an off-whitelist cover (a tracking beacon that loads by
 * itself), and one no `img-src` CSP constrains. Every blank row below is a way
 * such a link could otherwise reach a family member or an anonymous
 * public-shelf visitor.
 */
describe("sanitizeReadmooUrl", () => {
  // Values that survive byte-identical: the URL parser is consulted only for
  // the verdict, so a kept link is stored in its original spelling.
  it.each<{ label: string; input: string }>([
    { label: "the empty-string scraper placeholder", input: "" },
    {
      label: "an apex readmoo.com book link, the shape the scraper emits",
      input: "https://readmoo.com/book/210123456",
    },
    {
      label: "a subdomain of an allowed registrable domain",
      input: "https://next.readmoo.com/book/210123456",
    },
    {
      label: "the second allowed registrable domain (readmoo.tw)",
      input: "https://readmoo.tw/book/210123456",
    },
    {
      label: "an explicit :443, which the URL parser normalises away",
      input: "https://readmoo.com:443/book/210123456",
    },
  ])("keeps $label", ({ input }) => {
    expect(sanitizeReadmooUrl(input)).toBe(input);
  });

  // Everything else becomes "", which the clients already render as the normal
  // "no link available" state — sanitize, never reject.
  it.each<{ label: string; input: unknown }>([
    {
      label: "a plain-http URL on an allowed host",
      input: "http://readmoo.com/book/1",
    },
    {
      label: "an allowed host on a non-default port",
      input: "https://readmoo.com:8443/book/1",
    },
    {
      label: "a look-alike registrable domain",
      input: "https://evilreadmoo.com/book/1",
    },
    {
      label: "an allowed domain used as a leading label of another domain",
      input: "https://readmoo.com.evil.com/book/1",
    },
    {
      label: "an allowed domain smuggled into the userinfo segment",
      input: "https://readmoo.com@evil.example.com/book/1",
    },
    {
      label: "an outright foreign host",
      input: "https://evil.example.com/login",
    },
    { label: "a javascript: URL", input: "javascript:alert(1)" },
    { label: "a data: URL", input: "data:text/html,<h1>hi</h1>" },
    { label: "a protocol-relative URL", input: "//readmoo.com/book/1" },
    { label: "an unparseable string", input: "not a url" },
    { label: "a number", input: 123 },
    { label: "null", input: null },
    { label: "undefined (absent field)", input: undefined },
    {
      label: "an object wrapping a whitelisted URL",
      input: { href: "https://readmoo.com/book/1" },
    },
    {
      label: "an array wrapping a whitelisted URL",
      input: ["https://readmoo.com/book/1"],
    },
  ])("blanks $label", ({ input }) => {
    expect(sanitizeReadmooUrl(input)).toBe("");
  });

  // Same core defect as the cover boundary, different payoff: the click lands
  // the viewer on their OWN origin's `/public/x#invite=…`, which the PWA answers
  // by clearing the stored session (`apiHost` included) and pre-filling the
  // attacker's sync code — a self-origin lure no host allowlist on the RENDERED
  // href would catch, because the href is genuinely same-origin by then.
  // Mechanics and the shared-core reasoning: see BASE_SENSITIVE_URLS above.
  it.each(BASE_SENSITIVE_URLS)(
    "blanks $label, which resolves onto the viewer's own origin",
    ({ input }) => {
      expect(sanitizeReadmooUrl(input)).toBe("");
    },
  );
});

describe("isJsonObject", () => {
  it.each<{ label: string; value: unknown }>([
    { label: "an empty object", value: {} },
    { label: "a flat object", value: { a: 1 } },
    { label: "a nested object", value: { a: { b: { c: [1, 2] } } } },
    { label: "a displayName body", value: { displayName: "小明" } },
    { label: "an object holding a null value", value: { apiEndpoint: null } },
    { label: "an object parsed from JSON", value: JSON.parse('{"a":1}') },
  ])("accepts $label", ({ value }) => {
    expect(isJsonObject(value)).toBe(true);
  });

  it.each<{ label: string; value: unknown }>([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "an empty array", value: [] },
    { label: "a non-empty array", value: [1] },
    { label: "an array of objects", value: [{ a: 1 }] },
    { label: "an array parsed from JSON", value: JSON.parse("[1,2]") },
    { label: "a truthy number", value: 5 },
    { label: "zero", value: 0 },
    { label: "a truthy string", value: "x" },
    { label: "an empty string", value: "" },
    { label: "true", value: true },
    { label: "false", value: false },
  ])("rejects $label", ({ value }) => {
    expect(isJsonObject(value)).toBe(false);
  });

  // Why the helper exists: all three call sites (the family displayName and
  // apiEndpoint handlers, plus parseFamilyPrefs) evaluate `key in body`
  // immediately after this guard. A truthy primitive reaching `in` throws a
  // TypeError, which would surface as a 500 instead of a clean 400.
  it.each<{ label: string; value: unknown }>([
    { label: "a number", value: 5 },
    { label: "a string", value: "x" },
    { label: "a boolean", value: true },
  ])(
    "keeps a following `key in value` from throwing on $label",
    ({ value }) => {
      // Baseline: an unguarded `in` on a truthy primitive is exactly the failure
      // this guard prevents.
      expect(() => "displayName" in (value as object)).toThrow(TypeError);
      // The call-site pattern short-circuits before `in` is ever evaluated.
      expect(() => isJsonObject(value) && "displayName" in value).not.toThrow();
    },
  );

  it("narrows an accepted value to a keyed record", () => {
    const body: unknown = JSON.parse('{"displayName":"小明"}');
    expect(isJsonObject(body)).toBe(true);
    // Compile-time half of the contract: the `value is Record<string, unknown>`
    // predicate is what lets call sites read keys off a previously `unknown` body.
    if (!isJsonObject(body)) throw new Error("expected a JSON object");
    expect(body.displayName).toBe("小明");
  });
});
