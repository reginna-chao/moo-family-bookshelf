import { describe, it, expect } from "vitest";
import { isAllowedCoverUrl } from "moo-family-bookshelf-shared/config/readmoo";
import { safeCoverUrl } from "@/utils/safeCoverUrl";

/**
 * `safeCoverUrl` is the PWA's CODE-side half of the cover-URL beacon defence.
 * The other half is the CSP `img-src` in pwa/public/_headers (pinned by
 * tests/unit/cspHeaders.test.ts), but that file is only honoured by hosts that
 * serve it (Cloudflare Pages / Netlify) — under `vite dev` / `vite preview` or
 * on a plain static host no CSP is sent at all, and an already-stored hostile
 * `coverUrl` / `bookCoverUrl` would leak every viewer's IP / UA to a third
 * party through an `<img src>`. This wrapper is what covers those deployments.
 *
 * The exhaustive URL matrix (ports, userinfo smuggling, look-alike hosts,
 * unparseable input) belongs to the shared predicate and is already covered in
 * extension/tests/unit/readmooConfig.test.ts — this file only pins the WRAPPER
 * contract: an accepted URL comes back byte-identical, anything else collapses
 * to `""` so the caller renders its own empty-cover placeholder.
 */
describe("safeCoverUrl", () => {
  const cases: Array<{ name: string; url: string; expected: string }> = [
    {
      name: "a cover on the .com CDN",
      url: "https://cdn.readmoo.com/x.jpg",
      expected: "https://cdn.readmoo.com/x.jpg",
    },
    {
      name: "a cover on the .tw CDN",
      url: "https://cdn.readmoo.tw/x.jpg",
      expected: "https://cdn.readmoo.tw/x.jpg",
    },
    {
      name: "a tracking beacon on a foreign host",
      url: "https://evil.example/beacon.gif",
      expected: "",
    },
    {
      name: "plain HTTP on an allowed host",
      url: "http://cdn.readmoo.com/x.jpg",
      expected: "",
    },
    {
      // The one rejected shape that is NOT just "some other host": a scheme
      // with no `//` parses to `https://cdn.readmoo.com/x.jpg` on its own, but
      // an `<img src>` resolves it against the page it is rendered into, so it
      // fires on render at the PWA's OWN origin. The CSP cannot stand in for
      // the filter here even where _headers IS served: the resolved origin is
      // the page's own, which `img-src 'self'` already allows. Named
      // explicitly even though the delegation tripwire below would also catch
      // it, because this is the wrapper's only rejection whose input LOOKS
      // whitelisted. Full matrix: extension/tests/unit/readmooConfig.test.ts.
      name: "a bare scheme with no // that resolves against the rendering page",
      url: "https:cdn.readmoo.com/../../x.jpg",
      expected: "",
    },
    { name: "an empty string", url: "", expected: "" },
  ];

  for (const { name, url, expected } of cases) {
    it(`returns ${expected === "" ? "an empty string" : "the url verbatim"} for ${name}`, () => {
      expect(safeCoverUrl(url)).toBe(expected);
    });
  }

  // Delegation tripwire: the verdict must come from the shared predicate, never
  // from a second host list maintained here — that is the drift this wrapper
  // exists to avoid (the Worker, the CSP and the extension read the same list).
  it("mirrors isAllowedCoverUrl rather than deciding on its own", () => {
    for (const { url } of cases) {
      expect(safeCoverUrl(url)).toBe(isAllowedCoverUrl(url) ? url : "");
    }
  });

  /**
   * Return-type soundness — the mirror, on the way OUT, of the non-string
   * input rows in extension/tests/unit/readmooConfig.test.ts.
   *
   * Why a return already declared `string` still needs a `typeof` assertion:
   * `coverUrl` is deliberately excluded from the runtime text coercion at the
   * API-client boundary (see the `Not covered here, deliberately:` block of
   * `shared/src/api/safeText.ts`), so a hostile or merely buggy BYO backend can
   * land a non-string in this wrapper. The whitelist then judges the
   * `String()`-coerced value — `new URL` stringifies its argument, and
   * `String(["https://cdn.readmoo.com/x.jpg"])` IS that element — so a
   * one-element array is ACCEPTED, and unless the accept branch coerces too,
   * that array leaves here wearing a `string` type tag.
   *
   * Nothing crashes today: every consumer either drops the result into an
   * `<img src>`, which the DOM string-coerces, or tests it for truthiness. One
   * future `.startsWith()` on it would replay the exact white screen the
   * whitelist was just hardened against on the INPUT side — and with the
   * declaration already promising `string`, no type error warns anyone first.
   */
  describe("return-type soundness", () => {
    const ALLOWED_COVER = "https://cdn.readmoo.com/x.jpg";

    it("returns a real string, not the array it was handed", () => {
      // Cast at the call site only: the production signature stays strict, and
      // the cast is the honest spelling of what the network hands over.
      const result = safeCoverUrl([ALLOWED_COVER] as unknown as string);

      // Both assertions are load-bearing. `typeof` alone would also be
      // satisfied by a "fix" that blanked accepted URLs to `""` — the opposite
      // failure, in which every legitimate cover silently disappears.
      expect(typeof result).toBe("string");
      expect(result).toBe(ALLOWED_COVER);
    });

    it("passes a genuine string through byte-identically, on both verdicts", () => {
      // Pins that the coercion is an identity on real strings: no trimming, no
      // normalizing, and no change to either branch's existing answer.
      expect(safeCoverUrl(ALLOWED_COVER)).toBe(ALLOWED_COVER);
      expect(safeCoverUrl("https://evil.example/beacon.gif")).toBe("");
    });
  });
});
