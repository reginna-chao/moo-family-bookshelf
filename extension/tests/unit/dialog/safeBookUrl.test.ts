import { describe, it, expect } from "vitest";
import { isAllowedBookUrl } from "moo-family-bookshelf-shared/config/readmoo";
import { safeBookUrl } from "@/dialog/safeBookUrl";

/**
 * `safeBookUrl` is the extension's RENDER-time whitelist for the per-book
 * detail link (`readmooUrl`) on ANOTHER member's book, which arrives from the
 * server and is rendered as a clickable `<a href>`. A family member can bypass
 * the UI and POST any URL, and the dialog is injected into Readmoo pages that
 * send no CSP — and no CSP would help anyway, since `img-src` governs image
 * loads and says nothing about where a navigation may go. An off-whitelist
 * value is a phishing / arbitrary-redirect lure under a legitimate book title.
 *
 * The exhaustive URL matrix (ports, userinfo smuggling, look-alike hosts,
 * javascript:, unparseable input) belongs to the shared predicate and is
 * already covered in tests/unit/readmooConfig.test.ts — this file only pins the
 * WRAPPER contract: an accepted URL comes back byte-identical, anything else
 * collapses to `""` so the caller can omit the `href` attribute entirely.
 */
describe("safeBookUrl", () => {
  const cases: Array<{ name: string; url: string; expected: string }> = [
    {
      name: "the apex book-detail URL the scraper builds",
      url: "https://readmoo.com/book/210001",
      expected: "https://readmoo.com/book/210001",
    },
    {
      name: "a link on the .tw registrable domain",
      url: "https://readmoo.tw/book/210001",
      expected: "https://readmoo.tw/book/210001",
    },
    {
      name: "a phishing link on a foreign host",
      url: "https://evil.example.com/phish",
      expected: "",
    },
    {
      name: "a look-alike that only suffixes an allowed domain",
      url: "https://readmoo.com.evil.com/book/210001",
      expected: "",
    },
    {
      name: "plain HTTP on an allowed domain",
      url: "http://readmoo.com/book/210001",
      expected: "",
    },
    {
      // The one rejected shape that is NOT just "some other host": a scheme
      // with no `//` parses to `https://readmoo.com/public/x` on its own, but
      // an `<a href>` resolves it against the page it is rendered into, so in
      // the dialog it points at the VIEWER's origin. Named explicitly here
      // even though the delegation tripwire below would also catch it, because
      // this is the wrapper's only rejection whose input LOOKS whitelisted.
      // Full matrix + the exploit chain: tests/unit/readmooConfig.test.ts.
      name: "a bare scheme with no // that resolves against the rendering page",
      url: "https:readmoo.com/../../public/x#invite=moo-x",
      expected: "",
    },
    { name: "an empty string", url: "", expected: "" },
  ];

  for (const { name, url, expected } of cases) {
    it(`returns ${expected === "" ? "an empty string" : "the url verbatim"} for ${name}`, () => {
      expect(safeBookUrl(url)).toBe(expected);
    });
  }

  // Delegation tripwire: the verdict must come from the shared predicate, never
  // from a second domain list maintained here — that is the drift this wrapper
  // exists to avoid (the Worker, the PWA and this dialog read the same list).
  it("mirrors isAllowedBookUrl rather than deciding on its own", () => {
    for (const { url } of cases) {
      expect(safeBookUrl(url)).toBe(isAllowedBookUrl(url) ? url : "");
    }
  });

  /**
   * Return-type soundness — the mirror, on the way OUT, of the non-string
   * input rows in tests/unit/readmooConfig.test.ts.
   *
   * Why a return already declared `string` still needs a `typeof` assertion:
   * the value comes off the wire, and the whitelist judges its `String()`
   * coercion rather than the argument itself — `new URL` stringifies what it is
   * given, and `String(["https://readmoo.com/book/210001"])` IS that element —
   * so a one-element array is ACCEPTED, and unless the accept branch coerces
   * too, that array leaves here wearing a `string` type tag.
   *
   * `readmooUrl` does get coerced at the API-client boundary today, unlike its
   * `coverUrl` sibling (see the `Not covered here, deliberately:` block of
   * `shared/src/api/safeText.ts`), but that is another module's decision on one
   * of several paths into this wrapper, not a promise this one may lean on —
   * the same reason readmooConfig.test.ts asserts both predicates on identical
   * inputs.
   *
   * Nothing crashes today: callers write `href={safeBookUrl(u) || undefined}`,
   * which is a truthiness test followed by an attribute the DOM string-coerces.
   * One future `.startsWith()` on the result would replay the exact white
   * screen the whitelist was just hardened against on the INPUT side — and with
   * the declaration already promising `string`, no type error warns anyone
   * first.
   */
  describe("return-type soundness", () => {
    const ALLOWED_BOOK = "https://readmoo.com/book/210001";

    it("returns a real string, not the array it was handed", () => {
      // Cast at the call site only: the production signature stays strict, and
      // the cast is the honest spelling of what the network hands over.
      const result = safeBookUrl([ALLOWED_BOOK] as unknown as string);

      // Both assertions are load-bearing. `typeof` alone would also be
      // satisfied by a "fix" that blanked accepted URLs to `""` — the opposite
      // failure, in which every legitimate book link silently disappears.
      expect(typeof result).toBe("string");
      expect(result).toBe(ALLOWED_BOOK);
    });

    it("passes a genuine string through byte-identically, on both verdicts", () => {
      // Pins that the coercion is an identity on real strings: no trimming, no
      // normalizing, and no change to either branch's existing answer.
      expect(safeBookUrl(ALLOWED_BOOK)).toBe(ALLOWED_BOOK);
      expect(safeBookUrl("https://evil.example.com/phish")).toBe("");
    });
  });
});
