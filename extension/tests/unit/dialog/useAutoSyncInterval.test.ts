import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutoSyncInterval } from "@/dialog/useAutoSyncInterval";
import { AUTO_SYNC_INTERVAL_KEY } from "@/constants";

/**
 * The hook reads/writes the auto-sync interval via DIRECT `browser.storage.local`
 * access (storage/autoSyncInterval.ts), not `browser.runtime.sendMessage`
 * round-trips to the background. Firefox suspends the background event page, so
 * the old messaging path left the setting stuck at 「每天」 and snapped a choice of
 * 「永不」 back when the reply failed (Firefox Android). The test mock aliases `chrome.*`
 * and `browser.*` to the same spies (see tests/setup.ts), so mocking
 * `chrome.storage.local.{get,set}` observes exactly what production calls.
 *
 * The mount read is async, so assertions on the loaded value use `waitFor`.
 * `setInterval` writes fire-and-forget with a swallowed catch and NEVER rolls the
 * UI back on a storage failure. A mount read that resolves AFTER the user already
 * picked a value must not overwrite that choice (the "late mount read" case).
 */

function mockStoredInterval(value: unknown) {
  vi.mocked(chrome.storage.local.get).mockResolvedValue({
    [AUTO_SYNC_INTERVAL_KEY]: value,
  } as never);
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("useAutoSyncInterval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty storage → read normalizes to "daily".
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 'daily' before the stored value resolves", async () => {
    mockStoredInterval("never");
    const { result } = renderHook(() => useAutoSyncInterval());
    expect(result.current.interval).toBe("daily");
    // Settle the pending mount read inside act() to avoid a leaked update.
    await flushMicrotasks();
  });

  it.each(["never", "weekly", "monthly", "daily"] as const)(
    "reads '%s' from storage.local on mount",
    async (stored) => {
      mockStoredInterval(stored);
      const { result } = renderHook(() => useAutoSyncInterval());
      await waitFor(() => {
        expect(result.current.interval).toBe(stored);
      });
      expect(chrome.storage.local.get).toHaveBeenCalledWith([
        AUTO_SYNC_INTERVAL_KEY,
      ]);
    },
  );

  it.each([undefined, "yearly", "NEVER", "", 42, null, { interval: "never" }])(
    "normalizes the missing / invalid stored value %o to 'daily'",
    async (stored) => {
      if (stored === undefined) {
        vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
      } else {
        mockStoredInterval(stored);
      }
      const { result } = renderHook(() => useAutoSyncInterval());
      await flushMicrotasks();
      expect(chrome.storage.local.get).toHaveBeenCalled();
      expect(result.current.interval).toBe("daily");
    },
  );

  it("keeps 'daily' without throwing when the storage.local read rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );
    const { result } = renderHook(() => useAutoSyncInterval());
    await flushMicrotasks();
    expect(result.current.interval).toBe("daily");
  });

  it("updates state immediately and writes the choice to storage.local", async () => {
    const { result } = renderHook(() => useAutoSyncInterval());
    await flushMicrotasks();

    act(() => {
      result.current.setInterval("never");
    });

    expect(result.current.interval).toBe("never");
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [AUTO_SYNC_INTERVAL_KEY]: "never",
    });
  });

  it("keeps the chosen value when the storage.local write rejects (no rollback)", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );
    const { result } = renderHook(() => useAutoSyncInterval());
    await flushMicrotasks();
    expect(result.current.interval).toBe("daily");

    act(() => {
      result.current.setInterval("never");
    });
    expect(result.current.interval).toBe("never");

    // Flush the rejected write: the old hook snapped back to 'daily' here.
    await flushMicrotasks();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [AUTO_SYNC_INTERVAL_KEY]: "never",
    });
    expect(result.current.interval).toBe("never");
  });

  it("does not write to storage.local when setting the current value", async () => {
    mockStoredInterval("weekly");
    const { result } = renderHook(() => useAutoSyncInterval());
    await waitFor(() => {
      expect(result.current.interval).toBe("weekly");
    });

    act(() => {
      result.current.setInterval("weekly");
    });

    expect(result.current.interval).toBe("weekly");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("keeps the user's choice when the mount read resolves after it", async () => {
    let resolveRead!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.local.get).mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveRead = resolve;
      }) as never,
    );
    const { result } = renderHook(() => useAutoSyncInterval());

    act(() => {
      result.current.setInterval("weekly");
    });
    expect(result.current.interval).toBe("weekly");

    await act(async () => {
      resolveRead({ [AUTO_SYNC_INTERVAL_KEY]: "monthly" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.interval).toBe("weekly");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [AUTO_SYNC_INTERVAL_KEY]: "weekly",
    });
  });

  it("never messages the background to read or write the interval", async () => {
    mockStoredInterval("monthly");
    const { result } = renderHook(() => useAutoSyncInterval());
    await waitFor(() => {
      expect(result.current.interval).toBe("monthly");
    });

    act(() => {
      result.current.setInterval("never");
    });
    await flushMicrotasks();

    expect(chrome.storage.local.set).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
