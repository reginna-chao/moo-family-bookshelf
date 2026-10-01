import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ATTR_LIST_TOTAL, requestLibraryListTotal } from "@/content/fiber-data";

/**
 * `requestLibraryListTotal` (#236 F1): reads the list total the main-world
 * bridge publishes on `<html>`. Only a well-formed, safe, non-negative integer
 * written in answer to THIS request counts; anything else is `null` (unknown),
 * which makes the scrape incomplete.
 */

const root = document.documentElement;
let cleanupResponder: (() => void) | null = null;

/** A bridge stand-in: runs `onRequest`, then signals completion. */
function installResponder(onRequest: () => void): void {
  const handler = () => {
    onRequest();
    document.dispatchEvent(new CustomEvent("moo-fiber-data"));
  };
  document.addEventListener("moo-request-fiber-data", handler);
  cleanupResponder = () =>
    document.removeEventListener("moo-request-fiber-data", handler);
}

beforeEach(() => {
  // Bridge already injected → no script load wait.
  root.setAttribute("data-moo-fiber-bridge", "1");
  root.removeAttribute(ATTR_LIST_TOTAL);
});

afterEach(() => {
  cleanupResponder?.();
  cleanupResponder = null;
  vi.useRealTimers();
  root.removeAttribute("data-moo-fiber-bridge");
  root.removeAttribute(ATTR_LIST_TOTAL);
});

describe("ATTR_LIST_TOTAL", () => {
  it("is the attribute name the main-world bridge writes", () => {
    // Positive companion for the negative "attribute removed" assertions below.
    expect(ATTR_LIST_TOTAL).toBe("data-moo-list-total");
  });
});

describe("requestLibraryListTotal", () => {
  it("clears a stale total before asking the bridge", async () => {
    root.setAttribute(ATTR_LIST_TOTAL, "7");
    let seenAtRequest: string | null = "unset";
    installResponder(() => {
      seenAtRequest = root.getAttribute(ATTR_LIST_TOTAL);
    });

    const total = await requestLibraryListTotal();

    expect(seenAtRequest).toBeNull();
    // The bridge answered without a total → unknown, not the stale 7.
    expect(total).toBeNull();
  });

  it.each([
    { raw: "54", expected: 54 },
    { raw: "0", expected: 0 },
    { raw: "-1", expected: null },
    { raw: "5.5", expected: null },
    { raw: "abc", expected: null },
    { raw: "", expected: null },
    { raw: " 5", expected: null },
    { raw: "1e3", expected: null },
    { raw: "9007199254740993", expected: null },
    { raw: "99999999999999999999", expected: null },
  ])("reads $raw as $expected", async ({ raw, expected }) => {
    installResponder(() => root.setAttribute(ATTR_LIST_TOTAL, raw));

    await expect(requestLibraryListTotal()).resolves.toBe(expected);
  });

  it("returns the largest safe integer as-is", async () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    installResponder(() => root.setAttribute(ATTR_LIST_TOTAL, max));

    await expect(requestLibraryListTotal()).resolves.toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("returns null when the bridge never answers (after the request timeout)", async () => {
    vi.useFakeTimers();
    root.setAttribute(ATTR_LIST_TOTAL, "12");

    const promise = requestLibraryListTotal();
    await vi.advanceTimersByTimeAsync(2500);

    await expect(promise).resolves.toBeNull();
  });
});
