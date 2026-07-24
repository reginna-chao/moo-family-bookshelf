import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutoSyncInterval } from "@/dialog/useAutoSyncInterval";

/**
 * Production reads/writes the interval via the promise-based
 * `browser.runtime.sendMessage(msg)` (webextension-polyfill). The mock returns a
 * Promise resolving to the response keyed by message type — there is no Chrome
 * callback argument. The mount read is async, so assertions on the loaded value
 * use `waitFor`.
 */
function mockSendMessage(
  getResponse: Record<string, unknown>,
  setResponse: Record<string, unknown> = { ok: true },
) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((
    message: unknown,
  ) => {
    const msg = message as Record<string, unknown>;
    if (msg.type === "GET_AUTO_SYNC_INTERVAL") {
      return Promise.resolve(getResponse);
    }
    if (msg.type === "SET_AUTO_SYNC_INTERVAL") {
      return Promise.resolve(setResponse);
    }
    return Promise.resolve(undefined);
  }) as typeof chrome.runtime.sendMessage);
}

describe("useAutoSyncInterval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to 'daily'", () => {
    mockSendMessage({ interval: "daily" });
    const { result } = renderHook(() => useAutoSyncInterval());
    expect(result.current.interval).toBe("daily");
  });

  it.each(["weekly", "monthly", "never"] as const)(
    "reads '%s' from background on mount",
    async (interval) => {
      mockSendMessage({ interval });
      const { result } = renderHook(() => useAutoSyncInterval());
      await waitFor(() => {
        expect(result.current.interval).toBe(interval);
      });
    },
  );

  it("keeps 'daily' when the background message rejects", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((() =>
      Promise.reject(
        new Error("background unavailable"),
      )) as typeof chrome.runtime.sendMessage);
    const { result } = renderHook(() => useAutoSyncInterval());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.interval).toBe("daily");
  });

  it("optimistically updates state when setInterval is called", () => {
    mockSendMessage({ interval: "daily" });
    const { result } = renderHook(() => useAutoSyncInterval());

    act(() => {
      result.current.setInterval("weekly");
    });

    expect(result.current.interval).toBe("weekly");
  });

  it("sends SET_AUTO_SYNC_INTERVAL message on setInterval", () => {
    mockSendMessage({ interval: "daily" });
    const { result } = renderHook(() => useAutoSyncInterval());

    act(() => {
      result.current.setInterval("monthly");
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_AUTO_SYNC_INTERVAL",
      interval: "monthly",
    });
  });

  it("rolls back state when SET responds with ok: false", async () => {
    mockSendMessage({ interval: "daily" }, { ok: false });
    const { result } = renderHook(() => useAutoSyncInterval());

    act(() => {
      result.current.setInterval("never");
    });
    expect(result.current.interval).toBe("never");

    await waitFor(() => {
      expect(result.current.interval).toBe("daily");
    });
  });

  it("does not send message when setting same interval", () => {
    mockSendMessage({ interval: "daily" });
    const { result } = renderHook(() => useAutoSyncInterval());

    vi.mocked(chrome.runtime.sendMessage).mockClear();

    act(() => {
      result.current.setInterval("daily");
    });

    const setCalls = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.filter(
        (call) =>
          (call[0] as unknown as Record<string, unknown>).type ===
          "SET_AUTO_SYNC_INTERVAL",
      );
    expect(setCalls).toHaveLength(0);
  });
});
