import { describe, it, expect } from "vitest";
import browser from "webextension-polyfill";

/**
 * Guard for reviewer SUGGESTION S5 — the polyfill-mock resolution assumption.
 *
 * tests/setup.ts installs a single shared mock as BOTH `globalThis.chrome` and
 * `globalThis.browser` (the latter carries a valid `runtime.id`). The whole
 * suite's `chrome.*` / `browser.*` spy assertions only line up because
 * `import browser from "webextension-polyfill"` resolves to THAT exact mock —
 * the polyfill's documented behavior is: if `globalThis.browser` already exists
 * AND has `runtime.id`, return it verbatim instead of re-wrapping `chrome`.
 *
 * This is an undocumented-to-us internal of webextension-polyfill. If a future
 * major version drops the "return globalThis.browser verbatim" branch (e.g.
 * always re-wraps `chrome`), the imported `browser` would silently become a
 * DIFFERENT object than our mock. Suite-wide assertions could then break in
 * confusing ways, or — worse — pass against the wrong object.
 *
 * These assertions make that failure mode loud and localized: a polyfill
 * upgrade that breaks the assumption fails HERE with a clear message, not as a
 * mysterious cascade across the rest of the suite.
 */

interface GlobalWithExtensionApis {
  browser: typeof browser;
  chrome: typeof browser;
}

const globalApis = globalThis as unknown as GlobalWithExtensionApis;

describe("webextension-polyfill mock resolution", () => {
  it("resolves the default import to the mock installed on globalThis.browser", () => {
    expect(browser).toBe(globalApis.browser);
    // Fingerprint check: confirms it is OUR mock (id set in tests/setup.ts),
    // not a re-wrapped chrome that merely happens to expose runtime.id.
    expect(browser.runtime.id).toBe("mock-extension-id");
  });

  it("shares the same storage spies across the browser and chrome aliases", () => {
    // The suite depends on chrome.* and browser.* observing identical recorded
    // calls because they are the same spy object. Prove that aliasing holds.
    expect(browser.storage.local.get).toBe(globalApis.chrome.storage.local.get);
  });
});
