import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * hashNavigation (issue #271): the Dialog drives Readmoo's SPA by hash — to
 * `#/me` for the account check and onboarding — and must hand the page back on
 * the hash it found, on EVERY path. An abort (Dialog closed mid-check) must also
 * clear its settle timer, or a closed Dialog keeps a timer alive in the page.
 *
 * The scraper is the DOM boundary to the host page, so it is the one mock.
 * Every "restored" assertion is paired with a mid-wait assertion that the hash
 * really was `#/me`, so a restore that never happened cannot pass by accident.
 */

vi.mock("@/content/scraper", () => ({
  scrapeUserEmail: vi.fn(),
  scrapeDisplayName: vi.fn(),
}));

import {
  navigateAndRun,
  readMePageProfile,
  NAV_SETTLE_MS,
} from "@/content/hashNavigation";
import { scrapeUserEmail, scrapeDisplayName } from "@/content/scraper";

/** Put the jsdom URL on `hash` without firing hashchange ("" drops it). */
function setHash(hash: string): void {
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${hash}`,
  );
}

/**
 * jsdom queues every hashchange event on a 0ms window.setTimeout, which the fake
 * clock also counts. Deliver them so getTimerCount() sees only the settle timer
 * (1ms, not 0: the fake clock bumps a 0ms timer armed during a tick to 1ms).
 */
function deliverHashChanges(): void {
  vi.advanceTimersByTime(1);
}

describe("hashNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setHash("#/library");
    vi.mocked(scrapeUserEmail).mockReturnValue("owner@example.com");
    vi.mocked(scrapeDisplayName).mockReturnValue("Owner");
  });

  afterEach(() => {
    vi.useRealTimers();
    setHash("");
  });

  describe("navigateAndRun", () => {
    it("navigates, waits NAV_SETTLE_MS, then returns the task's result", async () => {
      const task = vi.fn(() => 42);

      const result = navigateAndRun("#/me", task);

      expect(location.hash).toBe("#/me");
      await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS - 1);
      expect(task).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(42);
      expect(task).toHaveBeenCalledOnce();
      // The caller owns the restore.
      expect(location.hash).toBe("#/me");
    });

    it("rejects without navigating when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const task = vi.fn();

      await expect(
        navigateAndRun("#/me", task, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(location.hash).toBe("#/library");
      expect(task).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects on abort mid-wait, skips the task and clears its timer", async () => {
      const controller = new AbortController();
      const task = vi.fn();

      const result = navigateAndRun("#/me", task, controller.signal);
      const settled = expect(result).rejects.toMatchObject({
        name: "AbortError",
      });
      deliverHashChanges();
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      await settled;

      deliverHashChanges();
      expect(vi.getTimerCount()).toBe(0);
      // Even if the original deadline passes, the task never runs.
      await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);
      expect(task).not.toHaveBeenCalled();
    });
  });

  describe("readMePageProfile", () => {
    it("reads the #/me panel and puts the page back on its hash", async () => {
      const result = readMePageProfile();

      expect(location.hash).toBe("#/me");
      await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);

      await expect(result).resolves.toEqual({
        email: "owner@example.com",
        displayName: "Owner",
      });
      expect(location.hash).toBe("#/library");
    });

    it("reports a missing email and display name as null / empty", async () => {
      vi.mocked(scrapeUserEmail).mockReturnValue(null);
      vi.mocked(scrapeDisplayName).mockReturnValue(null);

      const result = readMePageProfile();
      await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);

      await expect(result).resolves.toEqual({ email: null, displayName: "" });
      expect(location.hash).toBe("#/library");
    });

    it("lands on #/ when the page had no hash to go back to", async () => {
      setHash("");

      const result = readMePageProfile();
      expect(location.hash).toBe("#/me");
      await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);
      await result;

      expect(location.hash).toBe("#/");
    });

    it("restores the hash when the scrape throws", async () => {
      vi.mocked(scrapeUserEmail).mockImplementation(() => {
        throw new Error("panel changed");
      });

      const result = readMePageProfile();
      const settled = expect(result).rejects.toThrow("panel changed");
      expect(location.hash).toBe("#/me");
      await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);
      await settled;

      expect(location.hash).toBe("#/library");
    });

    it("restores the hash and clears the timer when aborted mid-wait", async () => {
      const controller = new AbortController();

      const result = readMePageProfile(controller.signal);
      const settled = expect(result).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(location.hash).toBe("#/me");
      deliverHashChanges();
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      await settled;

      expect(location.hash).toBe("#/library");
      deliverHashChanges();
      expect(vi.getTimerCount()).toBe(0);
      expect(scrapeUserEmail).not.toHaveBeenCalled();
    });

    it("never leaves the page when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const hashSets: string[] = [];
      const onHashChange = () => hashSets.push(location.hash);
      window.addEventListener("hashchange", onHashChange);

      try {
        await expect(
          readMePageProfile(controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        // Flush any hashchange a navigation would have queued.
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        window.removeEventListener("hashchange", onHashChange);
      }

      expect(hashSets).toEqual([]);
      expect(location.hash).toBe("#/library");
      expect(scrapeUserEmail).not.toHaveBeenCalled();
    });
  });
});
