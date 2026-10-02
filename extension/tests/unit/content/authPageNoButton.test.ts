/** @vitest-environment-options {"url": "https://next.readmoo.com/zh-TW/auth/signin"} */
import { describe, it, expect, vi, afterEach } from "vitest";
import { MOO_ELEMENT_IDS } from "@/utils/extensionContext";

/**
 * Regression test: the content script matches `https://next.readmoo.com/*`, so it
 * also runs on Readmoo's sign-in page (`/zh-TW/auth/signin`). The floating
 * 家庭書櫃 button must only appear inside the reader app (`/read/...`), never on
 * the sign-in page — neither on initial load nor after a hashchange.
 *
 * The jsdom URL is set for THIS file only via the environment-options docblock,
 * so the sibling content-script tests keep their default location. Mirroring
 * `dialogTeardown.test.ts`, page-ready resolves immediately; with the setup
 * file's already-resolved `browser.storage` mock the whole injection chain is
 * microtasks, so one macrotask hop (`flush`) is a deterministic barrier. The
 * positive control inside the test proves that same barrier is enough for the
 * button to appear when the path is allowed, so the absence checks cannot pass
 * vacuously. The content script's window/storage listeners are module-level and
 * unremovable; they die with this file's isolated jsdom environment.
 */

vi.mock("@/dialog/main", () => ({
  mountDialog: vi.fn(() => vi.fn()),
}));

vi.mock("@/content/pageReady", () => ({
  waitForPageReady: () => Promise.resolve(),
  PAGE_READY_TIMEOUT_MS: 5000,
}));

// Runs the top-level init at the sign-in URL. Static import so the vi.mock calls
// above are hoisted ahead of module evaluation.
import "@/content/index";

const SIGNIN_PATH = "/zh-TW/auth/signin?redirect=%2Fread%2F";
const READER_PATH = "/read/#/library";

/** One macrotask hop — drains the microtask-only injection chain. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function navigateTo(path: string): void {
  history.replaceState(null, "", path);
  window.dispatchEvent(new Event("hashchange"));
}

function buttonPresent(): boolean {
  return document.getElementById(MOO_ELEMENT_IDS.button) !== null;
}

afterEach(() => {
  document.getElementById(MOO_ELEMENT_IDS.button)?.remove();
  history.replaceState(null, "", SIGNIN_PATH);
});

describe("content script floating button", () => {
  it("is not injected on the next.readmoo.com sign-in page", async () => {
    // Initial load at the sign-in URL, plus a hashchange on the same page.
    await flush();
    expect(location.pathname).toBe("/zh-TW/auth/signin");
    expect(buttonPresent()).toBe(false);
    navigateTo(SIGNIN_PATH);
    await flush();
    expect(buttonPresent()).toBe(false);

    // Positive control: the same barrier injects the button inside the reader app.
    navigateTo(READER_PATH);
    await flush();
    expect(buttonPresent()).toBe(true);

    // Navigating back to sign-in removes it and does not re-inject.
    navigateTo(SIGNIN_PATH);
    await flush();
    expect(buttonPresent()).toBe(false);
  });
});
