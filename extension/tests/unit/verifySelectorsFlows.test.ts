import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { READMOO_SELECTORS } from "moo-family-bookshelf-shared/config/readmoo";
import { checkLendFlow } from "../../scripts/verify-selectors-flows";
import { SITES } from "../../scripts/verify-selectors-page";
import { buildSpecs } from "../../scripts/verify-selectors-specs";

/**
 * Regression for the manual live selector check (`pnpm e2e:verify:selectors`): a Playwright step
 * that THROWS mid-flow (here the card hover timing out) must be caught by `runFlow`, print
 * `⚠️ 流程中斷` and report the flow's rows ❌ — never reject and abort the run before the summaries
 * (.claude/rules/test.md → E2E tooling). The fake `Page` covers only what the lend flow reaches
 * before the throw plus `reloadLibrary`'s cleanup.
 */

function fakePage(hoverError: Error) {
  const site = SITES[0];
  const locator = {
    first: () => locator,
    count: () => Promise.resolve(1),
    hover: () => Promise.reject(hoverError),
    waitFor: () => Promise.resolve(),
  };
  const off = vi.fn(() => page);
  const page = {
    on: () => page,
    off,
    locator: () => locator,
    url: () => site.libraryUrl,
    goto: () => Promise.resolve(null),
    reload: () => Promise.resolve(null),
    waitForTimeout: () => Promise.resolve(),
    evaluate: () => Promise.resolve(undefined),
  };
  return { page: page as unknown as Page, off };
}

describe("checkLendFlow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports every lend row missing instead of rejecting when a Playwright step throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const specs = buildSpecs().LEND_FLOW_SELECTORS;
    const { page, off } = fakePage(
      new Error("locator.hover: Timeout 30000ms exceeded.\ncall log…"),
    );

    const results = await checkLendFlow(
      page,
      SITES[0],
      READMOO_SELECTORS,
      specs,
    );

    expect(results).toHaveLength(specs.length);
    expect(
      results.every((r) => !r.found && r.skippedReason === undefined),
    ).toBe(true);
    // At least one required row, so the flow shows ❌ rather than only ⚠️.
    expect(results.some((r) => r.required)).toBe(true);
    expect(off).toHaveBeenCalledWith("dialog", expect.any(Function));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "流程中斷：locator.hover: Timeout 30000ms exceeded.",
      ),
    );
  });
});
