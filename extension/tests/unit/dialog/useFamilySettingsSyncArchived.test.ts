import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFamilySettingsSyncArchived } from "@/dialog/useFamilySettingsSyncArchived";
import { useAccountSettingsUnsupported } from "@/dialog/AccountSettingsContext";
import { BoolFlag } from "@/api/client";
import { SYNC_ARCHIVED_KEY, USER_ID_KEY } from "@/constants";
import { ACCOUNT_SETTINGS_SAVE_FAILED } from "moo-family-bookshelf-shared/api/accountSettingsMessages";
import {
  accountSettingsWrapper,
  createAccountSettingsServer,
  type FakeAccountSettingsServer,
} from "../../helpers/accountSettingsServer";

/**
 * The 同步封存書籍 switch hook — an account setting shared with the PWA since #460, built on
 * `useAccountSetting`. It reads storage.local DIRECTLY (one read of the four account-setting keys),
 * never through `browser.runtime.sendMessage` round-trips to the background (issue #308: Firefox
 * suspends the background event page, so the old messaging path snapped the switch back to off).
 * The test mock aliases `chrome.*` and `browser.*` to the same spies (see tests/setup.ts), so
 * mocking `chrome.storage.local.{get,set}` observes exactly what production calls. Only an exact
 * BoolFlag.TRUE reads as on. A mount read that resolves AFTER the user already toggled must not
 * overwrite that choice.
 *
 * Twin contract (`.claude/rules/frontend.md` → the `useFamilySettingsSyncArchived` ↔
 * `useAccountSyncArchived` row; PWA side: pwa/tests/unit/useAccountSyncArchived.test.ts): inside
 * the Dialog's `AccountSettingsProvider` the toggle switches at once, then switches BACK with
 * 「儲存失敗，請稍後再試」 when the server refuses the save, writing nothing locally; a 404
 * `NOT_FOUND` keeps the change, writes it locally and marks the account settings unsupported (the
 * settings block then shows `ACCOUNT_SETTINGS_LOCAL_ONLY`, asserted in
 * tests/component/FamilySettings.test.tsx). Without a provider the toggle goes straight to
 * storage.local and a failed write keeps the switch where the user put it. Provider cases run on
 * the store-backed storage mock and the in-memory server of tests/helpers/accountSettingsServer.tsx.
 */

const USER = "a1b2c3d4e5f60718";

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
    expect(chrome.storage.local.get).toHaveBeenCalledWith(
      expect.arrayContaining([SYNC_ARCHIVED_KEY]),
    );
  });

  it.each([undefined, BoolFlag.FALSE, true, "1", 2, null])(
    "stays off for the stored value %o",
    async (stored) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      if (stored === undefined) {
        vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
      } else {
        mockStoredFlag(stored);
      }
      const { result } = renderHook(() => useFamilySettingsSyncArchived());
      await flushMicrotasks();
      expect(chrome.storage.local.get).toHaveBeenCalledWith(
        expect.arrayContaining([SYNC_ARCHIVED_KEY]),
      );
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
    "without a provider, toggles $from → $to immediately and writes it to storage.local",
    async ({ from, to }) => {
      mockStoredFlag(from);
      const { result } = renderHook(() => useFamilySettingsSyncArchived());
      await flushMicrotasks();
      expect(result.current.syncArchived).toBe(from);

      act(() => {
        result.current.handleToggleSyncArchived();
      });

      expect(result.current.syncArchived).toBe(to);
      await flushMicrotasks();
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [SYNC_ARCHIVED_KEY]: to,
      });
    },
  );

  it("without a provider, keeps the switch on when the storage.local write rejects", async () => {
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

    await flushMicrotasks();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
    });
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(result.current.message).toBe("");
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

describe("useFamilySettingsSyncArchived inside the account-settings provider", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER,
      [SYNC_ARCHIVED_KEY]: BoolFlag.FALSE,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function renderInProvider(server: FakeAccountSettingsServer) {
    const hook = renderHook(
      () => ({
        archived: useFamilySettingsSyncArchived(),
        unsupported: useAccountSettingsUnsupported(),
      }),
      { wrapper: accountSettingsWrapper(server.client, USER) },
    );
    await flushMicrotasks();
    vi.mocked(chrome.storage.local.set).mockClear();
    return hook;
  }

  async function toggle(result: {
    current: { archived: { handleToggleSyncArchived: () => void } };
  }) {
    await act(async () => {
      result.current.archived.handleToggleSyncArchived();
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("saves the toggle to the server and then caches it locally", async () => {
    const server = createAccountSettingsServer({
      syncArchived: BoolFlag.FALSE,
    });
    const { result } = await renderInProvider(server);

    await toggle(result);

    expect(server.patch).toHaveBeenCalledWith(USER, {
      settings: { syncArchived: BoolFlag.TRUE },
    });
    expect(result.current.archived.syncArchived).toBe(BoolFlag.TRUE);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
    });
  });

  it("switches back and shows the failure copy when the server refuses the save", async () => {
    expect(ACCOUNT_SETTINGS_SAVE_FAILED).toBe("儲存失敗，請稍後再試");
    const server = createAccountSettingsServer({
      syncArchived: BoolFlag.FALSE,
    });
    server.patch.mockResolvedValueOnce({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    const { result } = await renderInProvider(server);

    await toggle(result);

    expect(result.current.archived.syncArchived).toBe(BoolFlag.FALSE);
    expect(result.current.archived.message).toBe(ACCOUNT_SETTINGS_SAVE_FAILED);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("keeps the change locally and turns local-only on a server without the feature (404)", async () => {
    const server = createAccountSettingsServer({
      syncArchived: BoolFlag.FALSE,
    });
    server.patch.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const { result } = await renderInProvider(server);
    expect(result.current.unsupported).toBe(false);

    await toggle(result);

    expect(result.current.archived.syncArchived).toBe(BoolFlag.TRUE);
    expect(result.current.archived.message).toBe("");
    expect(result.current.unsupported).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
    });
  });

  it("follows a storage.onChanged write (another tab, or the open-time refresh caching the server's value)", async () => {
    const server = createAccountSettingsServer({
      syncArchived: BoolFlag.FALSE,
    });
    const { result } = await renderInProvider(server);
    const calls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const listener = calls[calls.length - 1][0] as (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => void;

    act(() => {
      listener({ [SYNC_ARCHIVED_KEY]: { newValue: BoolFlag.TRUE } }, "local");
    });

    expect(result.current.archived.syncArchived).toBe(BoolFlag.TRUE);
  });
});
