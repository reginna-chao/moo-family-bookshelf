import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { MOO_ELEMENT_IDS } from "@/utils/extensionContext";

/**
 * Tests for the content script's base button hover style injection
 * (`injectBaseButtonStyle`, driven via `injectFamilyBookshelfButton`).
 *
 * Both are module-private, so — mirroring `dialogTeardown.test.ts` — we drive
 * them the way production does: the content script's top-level init injects the
 * floating button on import, which calls `injectBaseButtonStyle`. We only need
 * the button-injection path here, so the dialog module and page-ready wait are
 * mocked to keep init synchronous and fast.
 *
 * Covered behaviour:
 *  1. A base <style> carrying the `@media (hover: hover)` rule for the button's
 *     `:hover { opacity: 0.8 }` is injected into document.head.
 *  2. The module-level guard injects that <style> exactly once, even when the
 *     button is removed and re-injected (cleanup removes the button, NOT the
 *     style — the guard prevents a duplicate).
 *  3. The floating button carries the `transition: opacity 0.2s ease-in` inline
 *     style that the hover effect animates.
 */

// The content script loads the React root from a code-split module at runtime
// via browser.runtime.getURL("content-dialog.js"). We never open the dialog in
// this file, but the mock keeps that boundary inert if a click ever fires.
vi.mock("@/dialog/main", () => ({
  mountDialog: vi.fn(() => vi.fn()),
}));

// Resolve page-ready immediately so init injects the button without waiting on
// Readmoo's spinner (avoids the real 5s fallback). pageReady has its own tests.
vi.mock("@/content/pageReady", () => ({
  waitForPageReady: () => Promise.resolve(),
  PAGE_READY_TIMEOUT_MS: 5000,
}));

// Importing the content script runs its top-level init (injects the floating
// button → injectBaseButtonStyle). Static import so the vi.mock calls above are
// hoisted ahead of module evaluation.
import "@/content/index";

const WAIT_TIMEOUT_MS = 10_000;
const WAIT_INTERVAL_MS = 10;

/** One macrotask hop. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function waitForCondition(
  isReady: () => boolean,
  describeTimeout: () => string,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!isReady()) throw new Error(describeTimeout());
    },
    { timeout: WAIT_TIMEOUT_MS, interval: WAIT_INTERVAL_MS },
  );
}

/** Wait until the top-level init (or a hashchange) has (re-)injected the button. */
async function ensureButtonInjected(): Promise<void> {
  if (document.getElementById(MOO_ELEMENT_IDS.button)) return;
  window.dispatchEvent(new Event("hashchange"));
  await waitForCondition(
    () => document.getElementById(MOO_ELEMENT_IDS.button) !== null,
    () => "timed out waiting for the floating button to be injected",
  );
}

function getButton(): HTMLElement {
  const btn = document.getElementById(MOO_ELEMENT_IDS.button);
  if (!btn) throw new Error("floating button was not injected");
  return btn;
}

/**
 * Collect the base hover <style> elements in document.head: those whose CSS text
 * carries the `@media (hover: hover)` wrapper AND the button's `:hover` selector.
 * The `(hover: hover)` marker is unique to this style (the dev env style has no
 * `:hover` rule), so the filter never mis-counts.
 */
function getHoverStyles(): HTMLStyleElement[] {
  return Array.from(document.head.querySelectorAll("style")).filter((el) => {
    const css = el.textContent ?? "";
    return (
      css.includes("(hover: hover)") &&
      css.includes(`#${MOO_ELEMENT_IDS.button}:hover`)
    );
  });
}

beforeAll(async () => {
  // Let the top-level init's async button injection settle before any test.
  await ensureButtonInjected();
  await tick();
});

beforeEach(async () => {
  await ensureButtonInjected();
});

afterEach(() => {
  // Guard against a leaked dialog host if a future edit opens one.
  document.getElementById(MOO_ELEMENT_IDS.host)?.remove();
});

describe("injectBaseButtonStyle", () => {
  it("injects a <style> with the hover-capable :hover opacity rule into document.head", () => {
    const styles = getHoverStyles();
    expect(styles).toHaveLength(1);

    const css = styles[0].textContent ?? "";
    // Wrapped in @media (hover: hover) so touch devices don't get sticky-hover.
    expect(css).toContain("@media (hover: hover)");
    // Scoped to the floating button id.
    expect(css).toContain(`#${MOO_ELEMENT_IDS.button}:hover`);
    // The hover effect itself.
    expect(css).toMatch(/opacity:\s*0\.8/);
  });

  it("injects the hover <style> only once across button re-injection", async () => {
    // Sanity: exactly one style after init.
    expect(getHoverStyles()).toHaveLength(1);

    // Simulate a hashchange re-injection: the button is removed and re-injected,
    // but the guarded style must NOT be duplicated (cleanup leaves it in place).
    getButton().remove();
    expect(document.getElementById(MOO_ELEMENT_IDS.button)).toBeNull();
    // The style survives button removal — this is precisely why the guard exists.
    expect(getHoverStyles()).toHaveLength(1);

    window.dispatchEvent(new Event("hashchange"));
    await waitForCondition(
      () => document.getElementById(MOO_ELEMENT_IDS.button) !== null,
      () => "timed out waiting for the button to be re-injected",
    );

    // Re-injection ran injectBaseButtonStyle again, but the module-level guard
    // short-circuited it — still exactly one hover style.
    expect(getHoverStyles()).toHaveLength(1);
  });
});

describe("floating button transition style", () => {
  it("applies the opacity transition the hover effect animates", () => {
    const css = getButton().style.cssText;
    expect(css).toContain("opacity 0.2s ease-in");
  });
});
