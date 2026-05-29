import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFamilyShelfViewMode } from "@/dialog/useFamilyShelfViewMode";

type SendMessageCallback = (response: Record<string, unknown>) => void;

function mockSendMessage(
  getResponse: Record<string, unknown>,
  setResponse: Record<string, unknown> = { ok: true },
) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    ((message: unknown, callback: SendMessageCallback) => {
      const msg = message as Record<string, unknown>;
      if (msg.type === "GET_FAMILY_SHELF_VIEW_MODE") {
        callback(getResponse);
      } else if (msg.type === "SET_FAMILY_SHELF_VIEW_MODE") {
        callback(setResponse);
      }
    }) as typeof chrome.runtime.sendMessage,
  );
}

describe("useFamilyShelfViewMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset lastError
    Object.defineProperty(chrome.runtime, "lastError", { value: null, writable: true, configurable: true });
  });

  it("defaults to 'grid'", () => {
    mockSendMessage({ viewMode: "grid" });
    const { result } = renderHook(() => useFamilyShelfViewMode());
    expect(result.current.viewMode).toBe("grid");
  });

  it("reads 'row' from background on mount", async () => {
    mockSendMessage({ viewMode: "row" });
    const { result } = renderHook(() => useFamilyShelfViewMode());
    // sendMessage callback is sync in mock → state updates immediately
    expect(result.current.viewMode).toBe("row");
  });

  it("keeps 'grid' when chrome.runtime.lastError is set", () => {
    Object.defineProperty(chrome.runtime, "lastError", {
      value: { message: "error" },
      writable: true,
      configurable: true,
    });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((_message: unknown, callback: SendMessageCallback) => {
        callback({ viewMode: "row" });
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useFamilyShelfViewMode());
    expect(result.current.viewMode).toBe("grid");
  });

  it("optimistically updates state when setViewMode is called", () => {
    mockSendMessage({ viewMode: "grid" });
    const { result } = renderHook(() => useFamilyShelfViewMode());

    act(() => {
      result.current.setViewMode("row");
    });

    expect(result.current.viewMode).toBe("row");
  });

  it("sends SET_FAMILY_SHELF_VIEW_MODE message on setViewMode", () => {
    mockSendMessage({ viewMode: "grid" });
    const { result } = renderHook(() => useFamilyShelfViewMode());

    act(() => {
      result.current.setViewMode("row");
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "SET_FAMILY_SHELF_VIEW_MODE", viewMode: "row" },
      expect.any(Function),
    );
  });

  it("rolls back state when SET responds with ok: false", async () => {
    // Use async callback to let React process the optimistic update before rollback
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((message: unknown, callback: SendMessageCallback) => {
        const msg = message as Record<string, unknown>;
        if (msg.type === "GET_FAMILY_SHELF_VIEW_MODE") {
          callback({ viewMode: "grid" });
        } else if (msg.type === "SET_FAMILY_SHELF_VIEW_MODE") {
          Promise.resolve().then(() => callback({ ok: false }));
        }
      }) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useFamilyShelfViewMode());

    act(() => {
      result.current.setViewMode("row");
    });
    // Optimistic: now "row"
    expect(result.current.viewMode).toBe("row");

    // Wait for the async callback to trigger rollback
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.viewMode).toBe("grid");
  });

  it("does not send message when setting same mode", () => {
    mockSendMessage({ viewMode: "grid" });
    const { result } = renderHook(() => useFamilyShelfViewMode());

    vi.mocked(chrome.runtime.sendMessage).mockClear();

    act(() => {
      result.current.setViewMode("grid");
    });

    // Only GET was called on mount; no SET call
    const setCalls = vi.mocked(chrome.runtime.sendMessage).mock.calls.filter(
      (call) => (call[0] as unknown as Record<string, unknown>).type === "SET_FAMILY_SHELF_VIEW_MODE",
    );
    expect(setCalls).toHaveLength(0);
  });
});
