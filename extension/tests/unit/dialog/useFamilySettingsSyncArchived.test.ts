import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFamilySettingsSyncArchived } from "@/dialog/useFamilySettingsSyncArchived";
import { BoolFlag } from "@/api/client";
import { SYNC_ARCHIVED_KEY } from "@/constants";

/**
 * The 同步封存書籍 switch hook reads/writes the flag via DIRECT
 * `browser.storage.local` access (storage/syncArchived.ts), not
 * `browser.runtime.sendMessage` round-trips to the background (issue #308). Firefox
 * suspends the background event page, so the old messaging path snapped the switch
 * back to off when the reply failed. The test mock aliases `chrome.*` and
 * `browser.*` to the same spies (see tests/setup.ts), so mocking
 * `chrome.storage.local.{get,set}` observes exactly what production calls.
 *
 * Only an exact BoolFlag.TRUE reads as on. The toggle writes fire-and-forget with a
 * swallowed catch and NEVER rolls the switch back on a storage failure. A mount read
 * that resolves AFTER the user already toggled must not overwrite that choice.
 */

function mockStoredFlag(value: unknown) {
  vi.mocked(chrome.storage.local.get).mockResolvedValue({
    [SYNC_ARCHIVED_KEY]: value,
  } as never);
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("useFamilySettingsSyncArchived", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is off before the stored value resolves", async () => {
    mockStoredFlag(BoolFlag.TRUE);
    const { result } = renderHook(() => useFamilySettingsSyncArchived());
    expect(result.current.syncArchived).toBe(BoolFlag.FALSE);
    // Settle the pending mount read inside act() to avoid a leaked update.
    await flushMicrotasks();
  });

  it("reads an exact BoolFlag.TRUE from storage.local on mount", async () => {
    mockStoredFlag(BoolFlag.TRUE);
    const { result } = renderHook(() => useFamilySettingsSyncArchived());
    await waitFor(() => {
      expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    });
    expect(chrome.storage.local.get).toHaveBeenCalledWith([SYNC_ARCHIVED_KEY]);
  });

  it.each([undefined, BoolFlag.FALSE, true, "1", 2, null])(
    "stays off for the stored value %o",
    async (stored) => {
      if (stored === undefined) {
        vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
      } else {
        mockStoredFlag(stored);
      }
      const { result } = renderHook(() => useFamilySettingsSyncArchived());
      await flushMicrotasks();
      expect(chrome.storage.local.get).toHaveBeenCalledWith([
        SYNC_ARCHIVED_KEY,
      ]);
      expect(result.current.syncArchived).toBe(BoolFlag.FALSE);
    },
  );

  it("stays off without throwing when the storage.local read rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );
    const { result } = renderHook(() => useFamilySettingsSyncArchived());
    await flushMicrotasks();
    expect(chrome.storage.local.get).toHaveBeenCalled();
    expect(result.current.syncArchived).toBe(BoolFlag.FALSE);
  });

  it.each([
    { from: BoolFlag.FALSE, to: BoolFlag.TRUE },
    { from: BoolFlag.TRUE, to: BoolFlag.FALSE },
  ])(
    "toggles $from → $to immediately and writes it to storage.local",
    async ({ from, to }) => {
      mockStoredFlag(from);
      const { result } = renderHook(() => useFamilySettingsSyncArchived());
      await flushMicrotasks();
      expect(result.current.syncArchived).toBe(from);

      act(() => {
        result.current.handleToggleSyncArchived();
      });

      expect(result.current.syncArchived).toBe(to);
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [SYNC_ARCHIVED_KEY]: to,
      });
    },
  );

  it("keeps the switch on when the storage.local write rejects (no rollback)", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );
    const { result } = renderHook(() => useFamilySettingsSyncArchived());
    await flushMicrotasks();
    expect(result.current.syncArchived).toBe(BoolFlag.FALSE);

    act(() => {
      result.current.handleToggleSyncArchived();
    });
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);

    // Flush the rejected write: the old hook snapped back to off here.
    await flushMicrotasks();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
    });
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
  });

  it("keeps the user's toggle when the mount read resolves after it", async () => {
    let resolveRead!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.local.get).mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveRead = resolve;
      }) as never,
    );
    const { result } = renderHook(() => useFamilySettingsSyncArchived());

    act(() => {
      result.current.handleToggleSyncArchived();
    });
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);

    await act(async () => {
      resolveRead({ [SYNC_ARCHIVED_KEY]: BoolFlag.FALSE });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
    });
  });

  it("never messages the background to read or write the flag", async () => {
    mockStoredFlag(BoolFlag.TRUE);
    const { result } = renderHook(() => useFamilySettingsSyncArchived());
    await waitFor(() => {
      expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    });

    act(() => {
      result.current.handleToggleSyncArchived();
    });
    await flushMicrotasks();

    expect(chrome.storage.local.get).toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
