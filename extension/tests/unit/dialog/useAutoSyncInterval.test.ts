import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutoSyncInterval } from "@/dialog/useAutoSyncInterval";
import { useAccountSettingsUnsupported } from "@/dialog/AccountSettingsContext";
import { AUTO_SYNC_INTERVAL_KEY, USER_ID_KEY } from "@/constants";
import { ACCOUNT_SETTINGS_SAVE_FAILED } from "moo-family-bookshelf-shared/api/accountSettingsMessages";
import {
  accountSettingsWrapper,
  createAccountSettingsServer,
  type FakeAccountSettingsServer,
} from "../../helpers/accountSettingsServer";

/**
 * The 自動同步頻率 hook — an account setting since #460, built on `useAccountSetting`. It reads
 * storage.local DIRECTLY (one read of the four account-setting keys), not through
 * `browser.runtime.sendMessage` round-trips to the background. Firefox suspends the background
 * event page, so the old messaging path left the setting stuck at 「每天」 and snapped a choice of
 * 「永不」 back when the reply failed (Firefox Android). The test mock aliases `chrome.*` and
 * `browser.*` to the same spies (see tests/setup.ts), so mocking `chrome.storage.local.{get,set}`
 * observes exactly what production calls.
 *
 * The mount read is async, so assertions on the loaded value use `waitFor`. A mount read that
 * resolves AFTER the user already picked a value must not overwrite that choice (the "late mount
 * read" case), and picking the current value sends nothing (acceptance 14). Without a provider
 * `setInterval` writes storage.local only and keeps the choice even when the write fails. Inside
 * the Dialog's `AccountSettingsProvider` (store-backed storage mock + the in-memory server of
 * tests/helpers/accountSettingsServer.tsx) a refused save switches back with
 * 「儲存失敗，請稍後再試」 and writes nothing; a 404 keeps the value locally and turns local-only.
 */

const USER = "a1b2c3d4e5f60718";

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
      expect(chrome.storage.local.get).toHaveBeenCalledWith(
        expect.arrayContaining([AUTO_SYNC_INTERVAL_KEY]),
      );
    },
  );

  it.each([undefined, "yearly", "NEVER", "", 42, null, { interval: "never" }])(
    "normalizes the missing / invalid stored value %o to 'daily'",
    async (stored) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
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
    // Settle the save's own state updates inside act().
    await flushMicrotasks();
  });

  it("without a provider, keeps the chosen value when the storage.local write rejects", async () => {
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

describe("useAutoSyncInterval inside the account-settings provider", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER,
      [AUTO_SYNC_INTERVAL_KEY]: "weekly",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function renderInProvider(server: FakeAccountSettingsServer) {
    const hook = renderHook(
      () => ({
        sync: useAutoSyncInterval(),
        unsupported: useAccountSettingsUnsupported(),
      }),
      { wrapper: accountSettingsWrapper(server.client, USER) },
    );
    await flushMicrotasks();
    vi.mocked(chrome.storage.local.set).mockClear();
    return hook;
  }

  async function pick(result: {
    current: { sync: { setInterval: (i: "never") => void } };
  }) {
    await act(async () => {
      result.current.sync.setInterval("never");
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("sends nothing when picking the current value", async () => {
    const server = createAccountSettingsServer({ autoSyncInterval: "weekly" });
    const { result } = await renderInProvider(server);

    await act(async () => {
      result.current.sync.setInterval("weekly");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(server.patch).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("switches back and shows the failure copy when the server refuses the save", async () => {
    const server = createAccountSettingsServer({ autoSyncInterval: "weekly" });
    server.patch.mockResolvedValueOnce({
      error: { code: "RATE_LIMITED", message: "slow down" },
    });
    const { result } = await renderInProvider(server);

    await pick(result);

    expect(server.patch).toHaveBeenCalledWith(USER, {
      settings: { autoSyncInterval: "never" },
    });
    expect(result.current.sync.interval).toBe("weekly");
    expect(result.current.sync.message).toBe(ACCOUNT_SETTINGS_SAVE_FAILED);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("keeps the value locally and turns local-only on a server without the feature (404)", async () => {
    const server = createAccountSettingsServer({ autoSyncInterval: "weekly" });
    server.patch.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const { result } = await renderInProvider(server);

    await pick(result);

    expect(result.current.sync.interval).toBe("never");
    expect(result.current.sync.message).toBe("");
    expect(result.current.unsupported).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [AUTO_SYNC_INTERVAL_KEY]: "never",
    });
  });

  it("follows a storage.onChanged write", async () => {
    const server = createAccountSettingsServer({ autoSyncInterval: "weekly" });
    const { result } = await renderInProvider(server);
    const calls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const listener = calls[calls.length - 1][0] as (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => void;

    act(() => {
      listener({ [AUTO_SYNC_INTERVAL_KEY]: { newValue: "monthly" } }, "local");
    });

    expect(result.current.sync.interval).toBe("monthly");
  });
});
