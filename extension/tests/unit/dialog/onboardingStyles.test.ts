import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { MOBILE_BREAKPOINT_PX } from "@/hooks/breakpoints";

/**
 * Class-contract tests for the onboarding layout rules in styles.css.
 *
 * `styles.css` is imported into the shadow root as a raw string (`?raw`), but
 * under Vitest that import resolves to an EMPTY string (Vite's CSS plugin
 * intercepts `.css` before `?raw` in the test transform — see main.test.ts).
 * So we read the stylesheet bytes directly from disk and assert on the CSS
 * text, which is the only observable contract for these purely-visual rules
 * (jsdom never applies stylesheet declarations).
 *
 * Covers three additions:
 *   1. Mobile onboarding centering media query (breakpoint === MOBILE_BREAKPOINT_PX).
 *   2. Restored `.moo-onboarding-view` 24px padding base rule.
 *   3. `.moo-modal .moo-onboarding-view` zero-padding anti-stack override.
 */

const STYLES_PATH = resolve(__dirname, "../../../src/dialog/styles.css");
const css = readFileSync(STYLES_PATH, "utf-8");

/**
 * Return the body (between braces) of the brace-block whose opening `{` is at
 * `openBraceIndex`, respecting nested braces (e.g. rules inside a media query).
 */
function blockBody(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  throw new Error("Unbalanced braces while extracting block body");
}

describe("onboarding-view padding rules", () => {
  it("keeps the restored base rule giving .moo-onboarding-view 24px padding", () => {
    // Regression guard: PR #64's inline-style→stylesheet migration dropped this
    // wrapper padding; the base rule must exist (and not match the modal override).
    expect(css).toMatch(/\.moo-onboarding-view\s*\{\s*padding:\s*24px;?\s*\}/);
  });

  it("zeroes the panel padding inside a modal so reauth prompt does not stack 20px + 24px", () => {
    expect(css).toMatch(
      /\.moo-modal\s+\.moo-onboarding-view\s*\{\s*padding:\s*0;?\s*\}/,
    );
  });

  it("declares the modal override AFTER the base rule so the cascade wins", () => {
    const baseIdx = css.search(/(^|\n)\.moo-onboarding-view\s*\{/);
    const overrideIdx = css.indexOf(".moo-modal .moo-onboarding-view");

    expect(baseIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(baseIdx);
  });
});

describe("mobile onboarding centering media query", () => {
  it("governs .moo-onboarding via a media query at the shared MOBILE_BREAKPOINT_PX", () => {
    // Anti-drift: the breakpoint is asserted against the imported constant, not a
    // hardcoded 767, so a change to breakpoints.ts forces this test to be updated.
    const childRuleIdx = css.indexOf(".moo-onboarding > *");
    expect(childRuleIdx).toBeGreaterThan(-1);

    const mediaOpenIdx = css.lastIndexOf("@media", childRuleIdx);
    expect(mediaOpenIdx).toBeGreaterThan(-1);

    const condition = css.slice(mediaOpenIdx, css.indexOf("{", mediaOpenIdx));
    expect(condition).toMatch(
      new RegExp(`max-width:\\s*${MOBILE_BREAKPOINT_PX}px`),
    );
  });

  it("makes .moo-onboarding a growing flex column and centers children with auto margins", () => {
    const childRuleIdx = css.indexOf(".moo-onboarding > *");
    const mediaOpenIdx = css.lastIndexOf("@media", childRuleIdx);
    const body = blockBody(css, css.indexOf("{", mediaOpenIdx));

    // .moo-onboarding grows to fill the forced-100vh mobile dialog...
    expect(body).toMatch(/\.moo-onboarding\s*\{[^}]*flex:\s*1/);
    expect(body).toMatch(/\.moo-onboarding\s*\{[^}]*display:\s*flex/);
    // ...and its direct children center via auto block margins (collapse on overflow).
    expect(body).toMatch(
      /\.moo-onboarding\s*>\s*\*\s*\{[^}]*margin-block:\s*auto/,
    );
  });

  it("keeps flex:1 scoped to the mobile media query (base .moo-onboarding stays position:relative)", () => {
    // The base rule must NOT carry the flex growth — that belongs only inside the
    // media query, otherwise desktop onboarding would stretch too.
    const baseMatch = css.match(/\.moo-onboarding\s*\{[^}]*\}/);
    expect(baseMatch).not.toBeNull();
    expect(baseMatch![0]).toContain("position: relative");
    expect(baseMatch![0]).not.toContain("flex: 1");
  });
});
