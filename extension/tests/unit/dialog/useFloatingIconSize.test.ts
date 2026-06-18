import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFloatingIconSize } from "@/dialog/useFloatingIconSize";

/**
 * Production reads/writes the icon size via the promise-based
 * `browser.runtime.sendMessage(msg)` (webextension-polyfill). The mock returns a
 * Promise resolving to the response keyed by message type — there is no Chrome
 * callback argument. The mount read is async, so assertions on the loaded value
 * use `waitFor`.
 */
function mockSendMessage(
  getResponse: Record<string, unknown>,
  setResponse: Record<string, unknown> = { ok: true },
) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    ((message: unknown) => {
      const msg = message as Record<string, unknown>;
      if (msg.type === "GET_FLOATING_ICON_SIZE") {
        return Promise.resolve(getResponse);
      }
      if (msg.type === "SET_FLOATING_ICON_SIZE") {
        return Promise.resolve(setResponse);
      }
      return Promise.resolve(undefined);
    }) as typeof chrome.runtime.sendMessage,
  );
}

describe("useFloatingIconSize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to 'medium'", () => {
    mockSendMessage({ size: "medium" });
    const { result } = renderHook(() => useFloatingIconSize());
    expect(result.current.size).toBe("medium");
  });

  it.each(["small", "large"] as const)("reads '%s' from background on mount", async (size) => {
    mockSendMessage({ size });
    const { result } = renderHook(() => useFloatingIconSize());
    await waitFor(() => {
      expect(result.current.size).toBe(size);
    });
  });

  it("keeps 'medium' when the background message rejects", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      (() => Promise.reject(new Error("background unavailable"))) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useFloatingIconSize());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
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

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_FLOATING_ICON_SIZE",
      size: "large",
    });
  });

  it("rolls back state when SET responds with ok: false", async () => {
    mockSendMessage({ size: "medium" }, { ok: false });
    const { result } = renderHook(() => useFloatingIconSize());

    act(() => {
      result.current.setSize("small");
    });
    expect(result.current.size).toBe("small");

    await waitFor(() => {
      expect(result.current.size).toBe("medium");
    });
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
