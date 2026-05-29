import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFloatingIconSize } from "@/dialog/useFloatingIconSize";

type SendMessageCallback = (response: Record<string, unknown>) => void;

function mockSendMessage(
  getResponse: Record<string, unknown>,
  setResponse: Record<string, unknown> = { ok: true },
) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    ((message: unknown, callback: SendMessageCallback) => {
      const msg = message as Record<string, unknown>;
      if (msg.type === "GET_FLOATING_ICON_SIZE") {
        callback(getResponse);
      } else if (msg.type === "SET_FLOATING_ICON_SIZE") {
        callback(setResponse);
      }
    }) as typeof chrome.runtime.sendMessage,
  );
}

describe("useFloatingIconSize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(chrome.runtime, "lastError", { value: null, writable: true, configurable: true });
  });

  it("defaults to 'medium'", () => {
    mockSendMessage({ size: "medium" });
    const { result } = renderHook(() => useFloatingIconSize());
    expect(result.current.size).toBe("medium");
  });

  it.each(["small", "large"] as const)("reads '%s' from background on mount", (size) => {
    mockSendMessage({ size });
    const { result } = renderHook(() => useFloatingIconSize());
    expect(result.current.size).toBe(size);
  });

  it("keeps 'medium' when chrome.runtime.lastError is set", () => {
    Object.defineProperty(chrome.runtime, "lastError", {
      value: { message: "error" },
      writable: true,
      configurable: true,
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((_message: unknown, callback: SendMessageCallback) => {
        callback({ size: "small" });
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useFloatingIconSize());
    expect(result.current.size).toBe("medium");
  });

  it("optimistically updates state when setSize is called", () => {
    mockSendMessage({ size: "medium" });
    const { result } = renderHook(() => useFloatingIconSize());

    act(() => {
      result.current.setSize("small");
    });

    expect(result.current.size).toBe("small");
  });

  it("sends SET_FLOATING_ICON_SIZE message on setSize", () => {
    mockSendMessage({ size: "medium" });
    const { result } = renderHook(() => useFloatingIconSize());

    act(() => {
      result.current.setSize("large");
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "SET_FLOATING_ICON_SIZE", size: "large" },
      expect.any(Function),
    );
  });

  it("rolls back state when SET responds with ok: false", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((message: unknown, callback: SendMessageCallback) => {
        const msg = message as Record<string, unknown>;
        if (msg.type === "GET_FLOATING_ICON_SIZE") {
          callback({ size: "medium" });
        } else if (msg.type === "SET_FLOATING_ICON_SIZE") {
          Promise.resolve().then(() => callback({ ok: false }));
        }
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useFloatingIconSize());

    act(() => {
      result.current.setSize("small");
    });
    expect(result.current.size).toBe("small");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.size).toBe("medium");
  });

  it("does not send message when setting same size", () => {
    mockSendMessage({ size: "medium" });
    const { result } = renderHook(() => useFloatingIconSize());

    vi.mocked(chrome.runtime.sendMessage).mockClear();

    act(() => {
      result.current.setSize("medium");
    });

    const setCalls = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(
      (call) => (call[0] as unknown as Record<string, unknown>).type === "SET_FLOATING_ICON_SIZE",
    );
    expect(setCalls).toHaveLength(0);
  });
});
