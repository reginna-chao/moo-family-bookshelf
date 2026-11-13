import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAccountSetting } from "@/dialog/useAccountSetting";
import type { ApiResponse } from "@/api/client";
import type { AccountSettings } from "moo-family-bookshelf-shared/api/accountSettings";
import { ACCOUNT_SETTINGS_SAVE_FAILED } from "moo-family-bookshelf-shared/api/accountSettingsMessages";
import {
  AUTO_SYNC_INTERVAL_KEY,
  FLOATING_ICON_SIZE_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  SYNC_ARCHIVED_KEY,
  USER_ID_KEY,
} from "@/constants";
import {
  accountSettingsWrapper,
  createAccountSettingsServer,
  type FakeAccountSettingsServer,
} from "../../helpers/accountSettingsServer";

/**
 * `useAccountSetting` (#460): one account setting on screen, shared by the four adapter hooks. The
 * value starts at `fallback`, then takes the stored value (one storage.local read of all four keys)
 * unless the user already changed it; `storage.onChanged` keeps it in step while no save is in
 * flight. `change` is optimistic: the screen switches at once, then the controller's outcome decides
 * — `failed` switches back with 「儲存失敗，請稍後再試」, `stale` (closed Dialog, other server)
 * switches back silently, `saved` / `localOnly` keep it. Picking the current value, or changing
 * while a save is in flight, is `skipped` and sends nothing (acceptance 14). Without a provider the
 * value goes straight to storage.local, as before #460, and a failed write keeps the choice on
 * screen (accepted deviation 7 in PLAN.md → Fix Cycle Log).
 *
 * Provider cases mount the REAL `AccountSettingsProvider` over the in-memory server of
 * tests/helpers/accountSettingsServer.tsx, seeded to match storage so the open-time refresh sends
 * no PATCH (a PATCH there would make a save wait out the 1.1 s gap). Storage is the store-backed
 * mock of tests/setup.ts, cleared around every case.
 */

const USER = "a1b2c3d4e5f60718";

function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function stored(): Promise<Record<string, unknown>> {
  return (await chrome.storage.local.get(null)) as Record<string, unknown>;
}

/** The `storage.onChanged` listener the hook registered last. */
function onChangedListener() {
  const calls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
  return calls[calls.length - 1][0] as (
    changes: Record<string, { newValue?: unknown }>,
    area: string,
  ) => void;
}

/** Render the size selector's setting inside the real provider, with storage and server agreeing. */
async function renderWithProvider(server: FakeAccountSettingsServer) {
  const hook = renderHook(
    () => useAccountSetting("floatingIconSize", "medium"),
    {
      wrapper: accountSettingsWrapper(server.client, USER),
    },
  );
  await flush();
  vi.mocked(chrome.storage.local.set).mockClear();
  return hook;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    [USER_ID_KEY]: USER,
    [FLOATING_ICON_SIZE_KEY]: "small",
  });
  vi.mocked(chrome.storage.local.set).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAccountSetting — reading", () => {
  it("starts at the fallback, then shows the stored value from one read of all four keys", async () => {
    const { result } = renderHook(() =>
      useAccountSetting("floatingIconSize", "medium"),
    );
    expect(result.current.value).toBe("medium");

    await flush();

    expect(result.current.value).toBe("small");
    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.get).toHaveBeenCalledWith(
      expect.arrayContaining([
        SYNC_ARCHIVED_KEY,
        AUTO_SYNC_INTERVAL_KEY,
        STORE_PAGE_CHIP_ENABLED_KEY,
        FLOATING_ICON_SIZE_KEY,
      ]),
    );
  });

  it.each([undefined, "huge", 1, null])(
    "keeps the fallback for the stored value %o",
    async (value) => {
      await chrome.storage.local.set({ [FLOATING_ICON_SIZE_KEY]: value });
      const { result } = renderHook(() =>
        useAccountSetting("floatingIconSize", "medium"),
      );
      await flush();
      expect(result.current.value).toBe("medium");
    },
  );

  it("follows a storage.onChanged write of its key, an invalid one as the fallback", async () => {
    const { result } = renderHook(() =>
      useAccountSetting("floatingIconSize", "medium"),
    );
    await flush();
    const listener = onChangedListener();

    act(() =>
      listener({ [FLOATING_ICON_SIZE_KEY]: { newValue: "large" } }, "local"),
    );
    expect(result.current.value).toBe("large");

    act(() =>
      listener({ [FLOATING_ICON_SIZE_KEY]: { newValue: "huge" } }, "local"),
    );
    expect(result.current.value).toBe("medium");
  });

  it("ignores storage.onChanged for another area or another key", async () => {
    const { result } = renderHook(() =>
      useAccountSetting("floatingIconSize", "medium"),
    );
    await flush();
    const listener = onChangedListener();

    act(() =>
      listener({ [FLOATING_ICON_SIZE_KEY]: { newValue: "large" } }, "sync"),
    );
    act(() =>
      listener({ [AUTO_SYNC_INTERVAL_KEY]: { newValue: "never" } }, "local"),
    );

    expect(result.current.value).toBe("small");
  });

  it("removes its storage.onChanged listener on unmount", async () => {
    const { unmount } = renderHook(() =>
      useAccountSetting("floatingIconSize", "medium"),
    );
    await flush();
    const listener = onChangedListener();

    unmount();

    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(
      listener,
    );
  });

  it("keeps the user's change when the mount read resolves after it", async () => {
    const read = held<Record<string, unknown>>();
    vi.mocked(chrome.storage.local.get).mockReturnValueOnce(
      read.promise as never,
    );
    const { result } = renderHook(() =>
      useAccountSetting("floatingIconSize", "medium"),
    );

    await act(async () => {
      await result.current.change("large");
    });
    read.release({ [FLOATING_ICON_SIZE_KEY]: "small" });
    await flush();

    expect(result.current.value).toBe("large");
  });
});

describe("useAccountSetting — without a provider", () => {
  it("writes storage.local only and resolves localOnly", async () => {
    const { result } = renderHook(() =>
      useAccountSetting("floatingIconSize", "medium"),
    );
    await flush();

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.change("large");
    });

    expect(outcome).toBe("localOnly");
    expect(result.current.value).toBe("large");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FLOATING_ICON_SIZE_KEY]: "large",
    });
  });

  it("keeps the choice on screen when the storage.local write rejects", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );
    const { result } = renderHook(() =>
      useAccountSetting("floatingIconSize", "medium"),
    );
    await flush();

    await act(async () => {
      await result.current.change("large");
    });

    expect(result.current.value).toBe("large");
    expect(result.current.message).toBe("");
  });
});

describe("useAccountSetting — with the provider", () => {
  it("resolves skipped and sends nothing for the value already selected", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const { result } = await renderWithProvider(server);
    expect(result.current.value).toBe("small");

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.change("small");
    });

    expect(outcome).toBe("skipped");
    expect(server.patch).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("saves through the server and keeps the new value", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const { result } = await renderWithProvider(server);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.change("large");
    });

    expect(outcome).toBe("saved");
    expect(server.patch).toHaveBeenCalledWith(USER, {
      settings: { floatingIconSize: "large" },
    });
    expect(result.current.value).toBe("large");
    expect(result.current.saving).toBe(false);
    expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBe("large");
  });

  it("switches back and shows the failure copy when the server refuses, writing nothing", async () => {
    expect(ACCOUNT_SETTINGS_SAVE_FAILED).toBe("儲存失敗，請稍後再試");
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    server.patch.mockResolvedValueOnce({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    const { result } = await renderWithProvider(server);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.change("large");
    });

    expect(outcome).toBe("failed");
    expect(result.current.value).toBe("small");
    expect(result.current.message).toBe(ACCOUNT_SETTINGS_SAVE_FAILED);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("clears the failure copy when the next change starts", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    server.patch.mockResolvedValueOnce({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    const { result } = await renderWithProvider(server);
    await act(async () => {
      await result.current.change("large");
    });
    expect(result.current.message).toBe(ACCOUNT_SETTINGS_SAVE_FAILED);

    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.change("icon");
    });
    expect(result.current.message).toBe("");

    await act(async () => {
      reply.release({ data: { floatingIconSize: "icon" } });
      await pending;
    });
  });

  it("switches back silently when the reply belongs to another server (stale)", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    const { result } = await renderWithProvider(server);

    let pending!: Promise<string>;
    act(() => {
      pending = result.current.change("large");
    });
    expect(result.current.value).toBe("large");
    server.setEndpoint("https://other.example.test");

    let outcome: string | undefined;
    await act(async () => {
      reply.release({ data: { floatingIconSize: "large" } });
      outcome = await pending;
    });

    expect(outcome).toBe("stale");
    expect(result.current.value).toBe("small");
    expect(result.current.message).toBe("");
  });

  it("keeps the value and writes it locally on a server without the feature (404)", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    server.patch.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const { result } = await renderWithProvider(server);

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.change("large");
    });

    expect(outcome).toBe("localOnly");
    expect(result.current.value).toBe("large");
    expect(result.current.message).toBe("");
    expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBe("large");
  });

  it("is saving while the save is out, skips a second change, and ignores onChanged meanwhile", async () => {
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    const { result } = await renderWithProvider(server);
    const listener = onChangedListener();

    let first!: Promise<string>;
    act(() => {
      first = result.current.change("large");
    });
    expect(result.current.saving).toBe(true);

    let second: string | undefined;
    await act(async () => {
      second = await result.current.change("icon");
    });
    expect(second).toBe("skipped");
    act(() =>
      listener({ [FLOATING_ICON_SIZE_KEY]: { newValue: "small" } }, "local"),
    );
    expect(result.current.value).toBe("large");

    await act(async () => {
      reply.release({ data: { floatingIconSize: "large" } });
      await first;
    });
    expect(server.patch).toHaveBeenCalledTimes(1);
    expect(result.current.saving).toBe(false);
    expect(result.current.value).toBe("large");
  });

  it("returns the outcome without updating state once unmounted", async () => {
    const error = vi.spyOn(console, "error");
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    const { result, unmount } = await renderWithProvider(server);

    let pending!: Promise<string>;
    act(() => {
      pending = result.current.change("large");
    });
    unmount();
    reply.release({ data: { floatingIconSize: "large" } });

    // The provider disposed the controller on unmount, so the reply is stale.
    await expect(pending).resolves.toBe("stale");
    expect(error).not.toHaveBeenCalled();
  });
});
