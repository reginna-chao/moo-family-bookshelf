import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFamilyShelfViewMode } from "@/dialog/useFamilyShelfViewMode";
import { FAMILY_SHELF_VIEW_MODE_KEY } from "@/constants";

/**
 * The hook now reads/writes the view mode via DIRECT `browser.storage.local`
 * access (storage/viewMode.ts) instead of `browser.runtime.sendMessage`
 * round-trips to the background — the Firefox sleeping-event-page fix. The test
 * mock aliases `chrome.*` and `browser.*` to the same spies (see tests/setup.ts),
 * so mocking `chrome.storage.local.{get,set}` observes exactly what production
 * calls through `browser.storage.local`.
 *
 * The mount read is async, so assertions on the loaded value use `waitFor`.
 * `setViewMode` writes fire-and-forget with a swallowed catch and NEVER rolls the
 * UI back on a storage failure — a lost persistence beats snapping the view back
 * under the user.
 */
function mockStoredViewMode(value: unknown) {
  vi.mocked(chrome.storage.local.get).mockResolvedValue({
    [FAMILY_SHELF_VIEW_MODE_KEY]: value,
  } as never);
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("useFamilyShelfViewMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty storage → read normalizes to "grid".
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 'grid' before the stored value resolves", async () => {
    mockStoredViewMode("row");
    const { result } = renderHook(() => useFamilyShelfViewMode());
    // Synchronous initial render, before the async mount read settles.
    expect(result.current.viewMode).toBe("grid");
    // Settle the pending mount read inside act() to avoid a leaked update.
    await flushMicrotasks();
  });

  it("reads 'row' from storage.local on mount", async () => {
    mockStoredViewMode("row");
    const { result } = renderHook(() => useFamilyShelfViewMode());
    await waitFor(() => {
      expect(result.current.viewMode).toBe("row");
    });
  });

  it("keeps 'grid' when the storage.local read rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );
    const { result } = renderHook(() => useFamilyShelfViewMode());
    await flushMicrotasks();
    expect(result.current.viewMode).toBe("grid");
  });

  it.each(["list", 42, null, undefined, "ROW", ""])(
    "normalizes the unknown stored value %o to 'grid'",
    async (stored) => {
      mockStoredViewMode(stored);
      const { result } = renderHook(() => useFamilyShelfViewMode());
      await flushMicrotasks();
      expect(result.current.viewMode).toBe("grid");
    },
  );

  it("updates state immediately when setViewMode is called", async () => {
    const { result } = renderHook(() => useFamilyShelfViewMode());
    await waitFor(() => {
      expect(result.current.viewMode).toBe("grid");
    });

    act(() => {
      result.current.setViewMode("row");
    });

    expect(result.current.viewMode).toBe("row");
  });

  it("writes the new mode to storage.local on setViewMode", async () => {
    const { result } = renderHook(() => useFamilyShelfViewMode());
    await waitFor(() => {
      expect(result.current.viewMode).toBe("grid");
    });

    act(() => {
      result.current.setViewMode("row");
    });

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FAMILY_SHELF_VIEW_MODE_KEY]: "row",
    });
  });

  it("does NOT revert the state when the storage.local write fails", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );
    const { result } = renderHook(() => useFamilyShelfViewMode());
    // Ensure the mount read settled (still "grid" from empty storage).
    await waitFor(() => {
      expect(result.current.viewMode).toBe("grid");
    });

    act(() => {
      result.current.setViewMode("row");
    });
    expect(result.current.viewMode).toBe("row");

    // Flush the rejected write's microtask. Without rollback the UI must stay
    // "row" — this is the inverse of the old (removed) rollback behavior.
    await flushMicrotasks();
    expect(result.current.viewMode).toBe("row");
  });

  it("does not write to storage.local when setting the same mode", async () => {
    const { result } = renderHook(() => useFamilyShelfViewMode());
    await waitFor(() => {
      expect(result.current.viewMode).toBe("grid");
    });

    vi.mocked(chrome.storage.local.set).mockClear();

    act(() => {
      result.current.setViewMode("grid");
    });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
