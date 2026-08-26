import { describe, it, expect } from "vitest";
import { isAllowedCoverUrl } from "moo-family-bookshelf-shared/config/readmoo";
import { safeCoverUrl } from "@/dialog/safeCoverUrl";

/**
 * `safeCoverUrl` is the extension's RENDER-time half of the cover-URL beacon
 * defence: the dialog is injected into Readmoo pages, which send no CSP, so
 * nothing but this wrapper stops an already-stored hostile `coverUrl` /
 * `bookCoverUrl` from leaking every viewer's IP / UA to a third party through
 * an `<img src>`.
 *
 * The exhaustive URL matrix (ports, userinfo smuggling, look-alike hosts,
 * unparseable input) belongs to the shared predicate and is already covered in
 * tests/unit/readmooConfig.test.ts — this file only pins the WRAPPER contract:
 * an accepted URL comes back byte-identical, anything else collapses to `""`
 * so the caller renders its own empty-cover placeholder.
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
    { name: "an empty string", url: "", expected: "" },
  ];

  for (const { name, url, expected } of cases) {
    it(`returns ${expected === "" ? "an empty string" : "the url verbatim"} for ${name}`, () => {
      expect(safeCoverUrl(url)).toBe(expected);
    });
  }

  // Delegation tripwire: the verdict must come from the shared predicate, never
  // from a second host list maintained here — that is the drift this wrapper
  // exists to avoid (the Worker and the PWA CSP read the same shared list).
  it("mirrors isAllowedCoverUrl rather than deciding on its own", () => {
    for (const { url } of cases) {
      expect(safeCoverUrl(url)).toBe(isAllowedCoverUrl(url) ? url : "");
    }
  });
});
