import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFloatingIconSize } from "@/dialog/useFloatingIconSize";
import { useAccountSettingsUnsupported } from "@/dialog/AccountSettingsContext";
import { FLOATING_ICON_SIZE_KEY, USER_ID_KEY } from "@/constants";
import { ACCOUNT_SETTINGS_SAVE_FAILED } from "moo-family-bookshelf-shared/api/accountSettingsMessages";
import {
  accountSettingsWrapper,
  createAccountSettingsServer,
  type FakeAccountSettingsServer,
} from "../../helpers/accountSettingsServer";

/**
 * The 家庭書櫃按鈕大小 hook — an account setting since #460, built on `useAccountSetting`. It
 * reads storage.local DIRECTLY (one read of the four account-setting keys), not through
 * `browser.runtime.sendMessage` round-trips to the background (issue #308). Firefox suspends the
 * background event page, so the old messaging path snapped a new size back to 「中」 when the
 * reply failed. The test mock aliases `chrome.*` and `browser.*` to the same spies (see
 * tests/setup.ts), so mocking `chrome.storage.local.{get,set}` observes exactly what production
 * calls.
 *
 * The mount read is async, so assertions on the loaded value use `waitFor`. A mount read that
 * resolves AFTER the user already picked a size must not overwrite that choice (the "late mount
 * read" case), and picking the current size sends nothing (acceptance 14). Without a provider
 * `setSize` writes storage.local only and keeps the choice even when the write fails. Inside the
 * Dialog's `AccountSettingsProvider` (store-backed storage mock + the in-memory server of
 * tests/helpers/accountSettingsServer.tsx) a refused save switches back with
 * 「儲存失敗，請稍後再試」 and writes nothing; a 404 keeps the size locally and turns local-only.
 */

const USER = "a1b2c3d4e5f60718";

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
      expect(chrome.storage.local.get).toHaveBeenCalledWith(
        expect.arrayContaining([FLOATING_ICON_SIZE_KEY]),
      );
    },
  );

  it.each([undefined, "huge", "LARGE", "", 42, null, { size: "large" }])(
    "normalizes the missing / invalid stored value %o to 'medium'",
    async (stored) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
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
    // Settle the save's own state updates inside act().
    await flushMicrotasks();
  });

  it("without a provider, keeps the chosen size when the storage.local write rejects", async () => {
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
    await flushMicrotasks();
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

describe("useFloatingIconSize inside the account-settings provider", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER,
      [FLOATING_ICON_SIZE_KEY]: "small",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function renderInProvider(server: FakeAccountSettingsServer) {
    const hook = renderHook(
      () => ({
        icon: useFloatingIconSize(),
        unsupported: useAccountSettingsUnsupported(),
      }),
      { wrapper: accountSettingsWrapper(server.client, USER) },
    );
    await flushMicrotasks();
    vi.mocked(chrome.storage.local.set).mockClear();
    return hook;
  }

  async function pick(result: {
    current: { icon: { setSize: (s: "large") => void } };
  }) {
    await act(async () => {
      result.current.icon.setSize("large");
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("sends nothing when picking the current size", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const { result } = await renderInProvider(server);

    await act(async () => {
      result.current.icon.setSize("small");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(server.patch).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("switches back and shows the failure copy when the server refuses the save", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    server.patch.mockResolvedValueOnce({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    const { result } = await renderInProvider(server);

    await pick(result);

    expect(server.patch).toHaveBeenCalledWith(USER, {
      settings: { floatingIconSize: "large" },
    });
    expect(result.current.icon.size).toBe("small");
    expect(result.current.icon.message).toBe(ACCOUNT_SETTINGS_SAVE_FAILED);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("keeps the size locally and turns local-only on a server without the feature (404)", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    server.patch.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const { result } = await renderInProvider(server);

    await pick(result);

    expect(result.current.icon.size).toBe("large");
    expect(result.current.icon.message).toBe("");
    expect(result.current.unsupported).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FLOATING_ICON_SIZE_KEY]: "large",
    });
  });

  it("follows a storage.onChanged write", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const { result } = await renderInProvider(server);
    const calls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const listener = calls[calls.length - 1][0] as (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => void;

    act(() => {
      listener({ [FLOATING_ICON_SIZE_KEY]: { newValue: "icon" } }, "local");
    });

    expect(result.current.icon.size).toBe("icon");
  });
});
