import { describe, it, expect, vi, afterEach } from "vitest";
import { showSyncErrorBadge, clearSyncErrorBadge } from "@/background/badge";

/**
 * Regression tests for the sync error badge helpers.
 *
 * Why this file exists: the bug these helpers were created to fix is that
 * `action` is undefined when the Manifest V3 `"action"` field is missing.
 *
 * Production reads the badge API via the webextension-polyfill `browser` import,
 * which (see tests/setup.ts) is the SAME object as `globalThis.browser`. The
 * `browser.action` property is read at call time on that live object, so these
 * tests mutate `globalThis.browser.action` in place (rather than replacing the
 * whole global, which the module's bound import reference would not observe) and
 * restore the original `action` afterwards.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const browserMock = (globalThis as any).browser as { action?: unknown };
const originalAction = browserMock.action;

afterEach(() => {
  browserMock.action = originalAction;
  vi.restoreAllMocks();
});

function stubBrowserWithAction(): {
  setBadgeText: ReturnType<typeof vi.fn>;
  setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
} {
  const setBadgeText = vi.fn();
  const setBadgeBackgroundColor = vi.fn();
  browserMock.action = { setBadgeText, setBadgeBackgroundColor };
  return { setBadgeText, setBadgeBackgroundColor };
}

function stubBrowserWithoutAction(): void {
  browserMock.action = undefined;
}

function stubBrowserActionPartial(): {
  setBadgeText: ReturnType<typeof vi.fn>;
} {
  const setBadgeText = vi.fn();
  browserMock.action = { setBadgeText };
  return { setBadgeText };
}

function stubBrowserActionEmpty(): void {
  browserMock.action = {};
}

describe("showSyncErrorBadge", () => {
  it("sets badge text to '!' and red background when browser.action is defined", () => {
    const { setBadgeText, setBadgeBackgroundColor } = stubBrowserWithAction();

    showSyncErrorBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "!" });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#EF4444" });
  });

  it("does nothing and does not throw when browser.action is undefined", () => {
    stubBrowserWithoutAction();

    expect(() => showSyncErrorBadge()).not.toThrow();
  });

  it("still sets badge text when setBadgeBackgroundColor is missing", () => {
    const { setBadgeText } = stubBrowserActionPartial();

    expect(() => showSyncErrorBadge()).not.toThrow();
    expect(setBadgeText).toHaveBeenCalledWith({ text: "!" });
  });

  it("does nothing when browser.action is defined but setBadgeText is missing", () => {
    stubBrowserActionEmpty();

    expect(() => showSyncErrorBadge()).not.toThrow();
  });
});

describe("clearSyncErrorBadge", () => {
  it("sets badge text to empty string when browser.action is defined", () => {
    const { setBadgeText } = stubBrowserWithAction();

    clearSyncErrorBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("does nothing and does not throw when browser.action is undefined", () => {
    stubBrowserWithoutAction();

    expect(() => clearSyncErrorBadge()).not.toThrow();
  });

  it("does nothing when browser.action is defined but setBadgeText is missing", () => {
    stubBrowserActionEmpty();

    expect(() => clearSyncErrorBadge()).not.toThrow();
  });
});
