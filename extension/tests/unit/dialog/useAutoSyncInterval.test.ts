import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoSyncInterval } from "@/dialog/useAutoSyncInterval";

type SendMessageCallback = (response: Record<string, unknown>) => void;

function mockSendMessage(
  getResponse: Record<string, unknown>,
  setResponse: Record<string, unknown> = { ok: true },
) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    ((message: unknown, callback: SendMessageCallback) => {
      const msg = message as Record<string, unknown>;
      if (msg.type === "GET_AUTO_SYNC_INTERVAL") {
        callback(getResponse);
      } else if (msg.type === "SET_AUTO_SYNC_INTERVAL") {
        callback(setResponse);
      }
    }) as typeof chrome.runtime.sendMessage,
  );
}

describe("useAutoSyncInterval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(chrome.runtime, "lastError", { value: null, writable: true, configurable: true });
  });

  it("defaults to 'daily'", () => {
    mockSendMessage({ interval: "daily" });
    const { result } = renderHook(() => useAutoSyncInterval());
    expect(result.current.interval).toBe("daily");
  });

  it.each(["weekly", "monthly", "never"] as const)(
    "reads '%s' from background on mount",
    (interval) => {
      mockSendMessage({ interval });
      const { result } = renderHook(() => useAutoSyncInterval());
      expect(result.current.interval).toBe(interval);
    },
  );

  it("keeps 'daily' when chrome.runtime.lastError is set", () => {
    Object.defineProperty(chrome.runtime, "lastError", {
      value: { message: "error" },
      writable: true,
      configurable: true,
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((_message: unknown, callback: SendMessageCallback) => {
        callback({ interval: "weekly" });
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useAutoSyncInterval());
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

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "SET_AUTO_SYNC_INTERVAL", interval: "monthly" },
      expect.any(Function),
    );
  });

  it("rolls back state when SET responds with ok: false", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((message: unknown, callback: SendMessageCallback) => {
        const msg = message as Record<string, unknown>;
        if (msg.type === "GET_AUTO_SYNC_INTERVAL") {
          callback({ interval: "daily" });
        } else if (msg.type === "SET_AUTO_SYNC_INTERVAL") {
          Promise.resolve().then(() => callback({ ok: false }));
        }
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useAutoSyncInterval());

    act(() => {
      result.current.setInterval("never");
    });
    expect(result.current.interval).toBe("never");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.interval).toBe("daily");
  });

  it("does not send message when setting same interval", () => {
    mockSendMessage({ interval: "daily" });
    const { result } = renderHook(() => useAutoSyncInterval());

    vi.mocked(chrome.runtime.sendMessage).mockClear();

    act(() => {
      result.current.setInterval("daily");
    });

    const setCalls = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(
      (call) =>
        (call[0] as unknown as Record<string, unknown>).type === "SET_AUTO_SYNC_INTERVAL",
    );
    expect(setCalls).toHaveLength(0);
  });
});
