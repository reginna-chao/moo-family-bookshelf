import { describe, it, expect, vi, afterEach } from "vitest";
import {
  showSyncErrorBadge,
  clearSyncErrorBadge,
} from "@/background/badge";

/**
 * Regression tests for the sync error badge helpers.
 *
 * Why this file exists: the bug these helpers were created to fix is that
 * `chrome.action` is undefined when the Manifest V3 `"action"` field is
 * missing. The global `chrome` mock in tests/setup.ts always defines
 * `chrome.action`, so these tests use `vi.stubGlobal` to simulate the broken
 * manifest case and assert the helpers fail safely.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubChromeWithAction(): {
  setBadgeText: ReturnType<typeof vi.fn>;
  setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
} {
  const setBadgeText = vi.fn();
  const setBadgeBackgroundColor = vi.fn();
  vi.stubGlobal("chrome", {
    action: { setBadgeText, setBadgeBackgroundColor },
  });
  return { setBadgeText, setBadgeBackgroundColor };
}

function stubChromeWithoutAction(): void {
  vi.stubGlobal("chrome", {});
}

function stubChromeActionPartial(): {
  setBadgeText: ReturnType<typeof vi.fn>;
} {
  const setBadgeText = vi.fn();
  vi.stubGlobal("chrome", {
    action: { setBadgeText },
  });
  return { setBadgeText };
}

function stubChromeActionEmpty(): void {
  vi.stubGlobal("chrome", { action: {} });
}

describe("showSyncErrorBadge", () => {
  it("sets badge text to '!' and red background when chrome.action is defined", () => {
    const { setBadgeText, setBadgeBackgroundColor } = stubChromeWithAction();

    showSyncErrorBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "!" });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#EF4444" });
  });

  it("does nothing and does not throw when chrome.action is undefined", () => {
    stubChromeWithoutAction();

    expect(() => showSyncErrorBadge()).not.toThrow();
  });

  it("still sets badge text when setBadgeBackgroundColor is missing", () => {
    const { setBadgeText } = stubChromeActionPartial();

    expect(() => showSyncErrorBadge()).not.toThrow();
    expect(setBadgeText).toHaveBeenCalledWith({ text: "!" });
  });

  it("does nothing when chrome.action is defined but setBadgeText is missing", () => {
    stubChromeActionEmpty();

    expect(() => showSyncErrorBadge()).not.toThrow();
  });
});

describe("clearSyncErrorBadge", () => {
  it("sets badge text to empty string when chrome.action is defined", () => {
    const { setBadgeText } = stubChromeWithAction();

    clearSyncErrorBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("does nothing and does not throw when chrome.action is undefined", () => {
    stubChromeWithoutAction();

    expect(() => clearSyncErrorBadge()).not.toThrow();
  });

  it("does nothing when chrome.action is defined but setBadgeText is missing", () => {
    stubChromeActionEmpty();

    expect(() => clearSyncErrorBadge()).not.toThrow();
  });
});
