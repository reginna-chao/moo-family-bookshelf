import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFamilyShelfViewMode } from "@/dialog/useFamilyShelfViewMode";

/**
 * Production reads/writes the view mode via the promise-based
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
      if (msg.type === "GET_FAMILY_SHELF_VIEW_MODE") {
        return Promise.resolve(getResponse);
      }
      if (msg.type === "SET_FAMILY_SHELF_VIEW_MODE") {
        return Promise.resolve(setResponse);
      }
      return Promise.resolve(undefined);
    }) as typeof chrome.runtime.sendMessage,
  );
}

describe("useFamilyShelfViewMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to 'grid'", () => {
    mockSendMessage({ viewMode: "grid" });
    const { result } = renderHook(() => useFamilyShelfViewMode());
    expect(result.current.viewMode).toBe("grid");
  });

  it("reads 'row' from background on mount", async () => {
    mockSendMessage({ viewMode: "row" });
    const { result } = renderHook(() => useFamilyShelfViewMode());
    await waitFor(() => {
      expect(result.current.viewMode).toBe("row");
    });
  });

  it("keeps 'grid' when the background message rejects", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      (() => Promise.reject(new Error("background unavailable"))) as typeof chrome.runtime.sendMessage,
    );
    const { result } = renderHook(() => useFamilyShelfViewMode());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
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

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "SET_FAMILY_SHELF_VIEW_MODE",
      viewMode: "row",
    });
  });

  it("rolls back state when SET responds with ok: false", async () => {
    mockSendMessage({ viewMode: "grid" }, { ok: false });
    const { result } = renderHook(() => useFamilyShelfViewMode());

    act(() => {
      result.current.setViewMode("row");
    });
    // Optimistic: now "row"
    expect(result.current.viewMode).toBe("row");

    // Wait for the rejected/ok:false response to trigger rollback
    await waitFor(() => {
      expect(result.current.viewMode).toBe("grid");
    });
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
