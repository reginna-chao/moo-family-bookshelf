import { describe, it, expect } from "vitest";
import { isAllowedBookUrl } from "moo-family-bookshelf-shared/config/readmoo";
import { safeBookUrl } from "@/utils/safeBookUrl";

/**
 * `safeBookUrl` is the PWA's RENDER-time whitelist for the per-book detail link
 * (`readmooUrl`) on ANOTHER member's book, which arrives from the server and is
 * rendered as a clickable `<a href>`. A family member can bypass the UI and
 * POST any URL, so an off-whitelist value is a phishing / arbitrary-redirect
 * lure served under a legitimate book title.
 *
 * Unlike `safeCoverUrl`, no CSP can stand in for this filter even where one is
 * served: `img-src` governs image loads and says nothing about where a
 * navigation may go — and pwa/public/_headers is in any case only honoured by
 * hosts that serve it (Cloudflare Pages / Netlify), never under `vite dev` /
 * `vite preview` or on a plain static host.
 *
 * The exhaustive URL matrix (ports, userinfo smuggling, look-alike hosts,
 * javascript:, unparseable input) belongs to the shared predicate and is
 * already covered in extension/tests/unit/readmooConfig.test.ts — this file
 * only pins the WRAPPER contract: an accepted URL comes back byte-identical,
 * anything else collapses to `""` so the caller can omit the `href` entirely.
 */
describe("safeBookUrl", () => {
  const cases: Array<{ name: string; url: string; expected: string }> = [
    {
      name: "the apex book-detail URL the extension scraper builds",
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
      // the PWA it points back at the PWA's OWN origin — the observed exploit
      // drove `/public/x#invite=…`, which clears the session and pre-fills the
      // attacker's sync code. Named explicitly even though the delegation
      // tripwire below would also catch it, because this is the wrapper's only
      // rejection whose input LOOKS whitelisted. Full matrix + exploit chain:
      // extension/tests/unit/readmooConfig.test.ts.
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
  // exists to avoid (the Worker, the extension and the PWA read the same list).
  it("mirrors isAllowedBookUrl rather than deciding on its own", () => {
    for (const { url } of cases) {
      expect(safeBookUrl(url)).toBe(isAllowedBookUrl(url) ? url : "");
    }
  });
});
