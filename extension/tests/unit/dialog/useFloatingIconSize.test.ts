import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFloatingIconSize } from "@/dialog/useFloatingIconSize";
import { FLOATING_ICON_SIZE_KEY } from "@/constants";

/**
 * The hook reads/writes the floating-button size via DIRECT `browser.storage.local`
 * access (storage/floatingIconSize.ts), not `browser.runtime.sendMessage`
 * round-trips to the background (issue #308). Firefox suspends the background event
 * page, so the old messaging path snapped a new size back to 「中」 when the reply
 * failed. The test mock aliases `chrome.*` and `browser.*` to the same spies (see
 * tests/setup.ts), so mocking `chrome.storage.local.{get,set}` observes exactly what
 * production calls.
 *
 * The mount read is async, so assertions on the loaded value use `waitFor`.
 * `setSize` writes fire-and-forget with a swallowed catch and NEVER rolls the UI
 * back on a storage failure. A mount read that resolves AFTER the user already
 * picked a size must not overwrite that choice (the "late mount read" case).
 */

function mockStoredSize(value: unknown) {
  vi.mocked(chrome.storage.local.get).mockResolvedValue({
    [FLOATING_ICON_SIZE_KEY]: value,
  } as never);
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("useFloatingIconSize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty storage → read normalizes to "medium".
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 'medium' before the stored value resolves", async () => {
    mockStoredSize("large");
    const { result } = renderHook(() => useFloatingIconSize());
    expect(result.current.size).toBe("medium");
    // Settle the pending mount read inside act() to avoid a leaked update.
    await flushMicrotasks();
  });

  it.each(["small", "medium", "large", "icon"] as const)(
    "reads '%s' from storage.local on mount",
    async (stored) => {
      mockStoredSize(stored);
      const { result } = renderHook(() => useFloatingIconSize());
      await waitFor(() => {
        expect(result.current.size).toBe(stored);
      });
      expect(chrome.storage.local.get).toHaveBeenCalledWith([
        FLOATING_ICON_SIZE_KEY,
      ]);
    },
  );

  it.each([undefined, "huge", "LARGE", "", 42, null, { size: "large" }])(
    "normalizes the missing / invalid stored value %o to 'medium'",
    async (stored) => {
      if (stored === undefined) {
        vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
      } else {
        mockStoredSize(stored);
      }
      const { result } = renderHook(() => useFloatingIconSize());
      await flushMicrotasks();
      expect(chrome.storage.local.get).toHaveBeenCalled();
      expect(result.current.size).toBe("medium");
    },
  );

  it("keeps 'medium' without throwing when the storage.local read rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );
    const { result } = renderHook(() => useFloatingIconSize());
    await flushMicrotasks();
    expect(chrome.storage.local.get).toHaveBeenCalled();
    expect(result.current.size).toBe("medium");
  });

  it("updates state immediately and writes the choice to storage.local", async () => {
    const { result } = renderHook(() => useFloatingIconSize());
    await flushMicrotasks();

    act(() => {
      result.current.setSize("large");
    });

    expect(result.current.size).toBe("large");
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FLOATING_ICON_SIZE_KEY]: "large",
    });
  });

  it("keeps the chosen size when the storage.local write rejects (no rollback)", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );
    const { result } = renderHook(() => useFloatingIconSize());
    await flushMicrotasks();
    expect(result.current.size).toBe("medium");

    act(() => {
      result.current.setSize("large");
    });
    expect(result.current.size).toBe("large");

    // Flush the rejected write: the old hook snapped back to 'medium' here.
    await flushMicrotasks();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FLOATING_ICON_SIZE_KEY]: "large",
    });
    expect(result.current.size).toBe("large");
  });

  it("does not write to storage.local when setting the current size", async () => {
    mockStoredSize("small");
    const { result } = renderHook(() => useFloatingIconSize());
    await waitFor(() => {
      expect(result.current.size).toBe("small");
    });

    act(() => {
      result.current.setSize("small");
    });

    expect(result.current.size).toBe("small");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();

    // Positive companion: a different size from the same state does write.
    act(() => {
      result.current.setSize("icon");
    });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FLOATING_ICON_SIZE_KEY]: "icon",
    });
  });

  it("keeps the user's choice when the mount read resolves after it", async () => {
    let resolveRead!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.local.get).mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveRead = resolve;
      }) as never,
    );
    const { result } = renderHook(() => useFloatingIconSize());

    act(() => {
      result.current.setSize("icon");
    });
    expect(result.current.size).toBe("icon");

    await act(async () => {
      resolveRead({ [FLOATING_ICON_SIZE_KEY]: "small" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.size).toBe("icon");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FLOATING_ICON_SIZE_KEY]: "icon",
    });
  });

  it("never messages the background to read or write the size", async () => {
    mockStoredSize("small");
    const { result } = renderHook(() => useFloatingIconSize());
    await waitFor(() => {
      expect(result.current.size).toBe("small");
    });

    act(() => {
      result.current.setSize("large");
    });
    await flushMicrotasks();

    expect(chrome.storage.local.get).toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
