import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useTokenRefresh } from "@/dialog/useTokenRefresh";
import type { ApiClient } from "@/api/client";
import { TOKEN_EXPIRES_AT_KEY } from "@/constants";

/**
 * useTokenRefresh is the PROACTIVE arm of the token-refresh strategy and is
 * load-bearing for Security-UX Invariant #2 ("token expiry MUST NOT silently
 * drop data; the client MUST refresh / prompt re-auth"). These tests exercise
 * the scheduler behaviour against the shared webextension mock (tests/setup.ts),
 * whose `chrome`/`browser` aliases share one backing KV store — so seeding via
 * `chrome.storage.local.set` is exactly what the hook reads via
 * `browser.storage.local.get`.
 *
 * All timing is driven by fake timers; every test restores real timers.
 */

const MINUTE = 60 * 1000;

/** Seed (or clear) the stored token-expiry timestamp the hook reads on mount. */
async function seedExpiry(expiresAt: number | undefined): Promise<void> {
  await chrome.storage.local.clear();
  if (expiresAt !== undefined) {
    await chrome.storage.local.set({ [TOKEN_EXPIRES_AT_KEY]: expiresAt });
  }
}

/**
 * Minimal ApiClient stub — the hook only ever calls `proactiveRefresh()`.
 * Mocking the API client (external boundary) is per test.md's mock policy.
 */
function createMockApiClient(
  proactiveRefresh: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(true),
): { client: ApiClient; proactiveRefresh: ReturnType<typeof vi.fn> } {
  return { client: { proactiveRefresh } as unknown as ApiClient, proactiveRefresh };
}

/** Drain the hook's in-flight async scheduleRefresh chain and any 0ms timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("useTokenRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T00:00:00.000Z"));
    setVisibility("visible");
  });

  afterEach(async () => {
    vi.useRealTimers();
    setVisibility("visible");
    await chrome.storage.local.clear();
  });

  it("schedules a refresh 5 minutes before expiry and does not fire early", async () => {
    const expiresAt = Date.now() + 30 * MINUTE; // buffer is 5min → schedule at +25min
    await seedExpiry(expiresAt);
    const { client, proactiveRefresh } = createMockApiClient();

    renderHook(() => useTokenRefresh(client));
    await flush();

    // Nothing fires on mount — token is comfortably in the future.
    expect(proactiveRefresh).not.toHaveBeenCalled();

    // One second before the 25-minute mark: still not fired.
    await vi.advanceTimersByTimeAsync(25 * MINUTE - 1000);
    expect(proactiveRefresh).not.toHaveBeenCalled();

    // Crossing the mark (now 5min before expiry) triggers the refresh.
    await vi.advanceTimersByTimeAsync(1000);
    expect(proactiveRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes immediately when the token is already within the refresh buffer", async () => {
    const expiresAt = Date.now() + 2 * MINUTE; // inside the 5-minute buffer
    await seedExpiry(expiresAt);
    const { client, proactiveRefresh } = createMockApiClient();

    renderHook(() => useTokenRefresh(client));
    await flush();

    // Inv-2: a near-expiry token must be refreshed at once, not left to lapse.
    expect(proactiveRefresh).toHaveBeenCalledTimes(1);
  });

  it("reschedules the next refresh based on the new expiry after a successful refresh", async () => {
    await seedExpiry(Date.now() + 2 * MINUTE); // triggers an immediate refresh
    const proactiveRefresh = vi.fn().mockImplementation(async () => {
      // A successful refresh extends the token by 30 minutes.
      await chrome.storage.local.set({
        [TOKEN_EXPIRES_AT_KEY]: Date.now() + 30 * MINUTE,
      });
      return true;
    });
    const client = { proactiveRefresh } as unknown as ApiClient;

    renderHook(() => useTokenRefresh(client));
    await flush();
    expect(proactiveRefresh).toHaveBeenCalledTimes(1);

    // Next refresh must be scheduled off the NEW expiry (now + 30min → +25min).
    await vi.advanceTimersByTimeAsync(25 * MINUTE - 1000);
    expect(proactiveRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(proactiveRefresh).toHaveBeenCalledTimes(2);
  });

  it("clears its scheduled timer on unmount so no refresh fires afterwards", async () => {
    await seedExpiry(Date.now() + 30 * MINUTE);
    const { client, proactiveRefresh } = createMockApiClient();

    const { unmount } = renderHook(() => useTokenRefresh(client));
    await flush();
    expect(proactiveRefresh).not.toHaveBeenCalled();

    unmount();

    // Advance well past the scheduled refresh — the timer must be gone.
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(proactiveRefresh).not.toHaveBeenCalled();
  });

  it("does nothing when no token expiry is stored", async () => {
    await seedExpiry(undefined);
    const { client, proactiveRefresh } = createMockApiClient();

    renderHook(() => useTokenRefresh(client));
    await flush();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(proactiveRefresh).not.toHaveBeenCalled();
  });

  it("recalibrates and refreshes when the page becomes visible and the token is now near expiry", async () => {
    await seedExpiry(Date.now() + 30 * MINUTE); // far → scheduled at +25min, no immediate refresh
    const { client, proactiveRefresh } = createMockApiClient();

    renderHook(() => useTokenRefresh(client));
    await flush();
    expect(proactiveRefresh).not.toHaveBeenCalled();

    // While the tab was hidden the token drifted to inside the buffer.
    await chrome.storage.local.set({ [TOKEN_EXPIRES_AT_KEY]: Date.now() + 2 * MINUTE });

    // Returning to the page recalibrates: recomputed delay <= 0 → refresh now.
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();

    expect(proactiveRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not recalibrate when a visibilitychange fires while the page is hidden", async () => {
    await seedExpiry(Date.now() + 30 * MINUTE);
    const { client, proactiveRefresh } = createMockApiClient();

    renderHook(() => useTokenRefresh(client));
    await flush();

    const getCallsBefore = vi.mocked(chrome.storage.local.get).mock.calls.length;

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();

    // Hidden-tab guard: no extra storage read, no refresh.
    expect(vi.mocked(chrome.storage.local.get).mock.calls.length).toBe(getCallsBefore);
    expect(proactiveRefresh).not.toHaveBeenCalled();
  });

  it("skips scheduling entirely when the extension context is invalid", async () => {
    await seedExpiry(Date.now() + 2 * MINUTE);
    const { client, proactiveRefresh } = createMockApiClient();

    // Simulate a reloaded extension: runtime.id is no longer available, so
    // isExtensionContextValid() returns false before any storage access.
    const originalId = chrome.runtime.id;
    Object.defineProperty(chrome.runtime, "id", { configurable: true, value: undefined });

    renderHook(() => useTokenRefresh(client));
    await flush();

    expect(vi.mocked(chrome.storage.local.get)).not.toHaveBeenCalled();
    expect(proactiveRefresh).not.toHaveBeenCalled();

    Object.defineProperty(chrome.runtime, "id", { configurable: true, value: originalId });
  });

  it("does not schedule a follow-up refresh when the immediate refresh fails", async () => {
    await seedExpiry(Date.now() + 2 * MINUTE);
    const proactiveRefresh = vi.fn().mockResolvedValue(false);
    const client = { proactiveRefresh } as unknown as ApiClient;

    renderHook(() => useTokenRefresh(client));
    await flush();
    expect(proactiveRefresh).toHaveBeenCalledTimes(1);

    // A failed refresh must not leave a dangling retry timer.
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(proactiveRefresh).toHaveBeenCalledTimes(1);
  });

  it("returns early without refreshing when reading storage throws", async () => {
    await seedExpiry(Date.now() + 2 * MINUTE);
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
      new Error("Extension context invalidated"),
    );
    const { client, proactiveRefresh } = createMockApiClient();

    renderHook(() => useTokenRefresh(client));
    await flush();

    // The try/catch around the storage read must swallow the error, not refresh.
    expect(proactiveRefresh).not.toHaveBeenCalled();
  });
});
