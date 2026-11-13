import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAccountSyncArchived } from "@/hooks/useAccountSyncArchived";
import { namespacedKey } from "@/hooks/useAuth";
import { BoolFlag, type ApiClient } from "@/api/client";
import type {
  AccountSettings,
  AccountSettingsPatch,
} from "moo-family-bookshelf-shared/api/accountSettings";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import {
  ACCOUNT_SETTINGS_LOCAL_ONLY,
  ACCOUNT_SETTINGS_SAVE_FAILED,
} from "moo-family-bookshelf-shared/api/accountSettingsMessages";

/**
 * `useAccountSyncArchived` (#460): the PWA's 同步封存書籍 switch, an account setting shared with the
 * Extension. localStorage (`namespacedKey(userId, "syncArchived")`) is the cache shown first; each
 * mount then reads the server once and follows its value, writing the cache too. The PWA never fills
 * in a value the account lacks: no value on the server keeps the cached one and sends nothing, and
 * no PATCH ever carries `ifAbsent` (acceptance 6). A reply that lands after the user toggled is
 * dropped whole — state, cache and message (acceptance 16) — since it may predate the save.
 *
 * Twin contract (`.claude/rules/frontend.md` → the `useFamilySettingsSyncArchived` ↔
 * `useAccountSyncArchived` row; Extension side:
 * extension/tests/unit/dialog/useFamilySettingsSyncArchived.test.ts): the toggle switches at once
 * and switches BACK — state and cache — with 「儲存失敗，請稍後再試」 when the save is refused (the
 * cache is restored even after the page unmounted, accepted deviation 8 in PLAN.md); a 404
 * `NOT_FOUND`, on the read or on a save, keeps every change local and shows
 * `ACCOUNT_SETTINGS_LOCAL_ONLY` (acceptance 5). While a save is out, another toggle is ignored.
 */

const USER = "user-abc12345";
const CACHE_KEY = namespacedKey(USER, "syncArchived");

type Get = (userId: string) => Promise<ApiResponse<AccountSettings>>;
type Patch = (
  userId: string,
  patch: AccountSettingsPatch,
) => Promise<ApiResponse<AccountSettings>>;

function createClient(read: ApiResponse<AccountSettings> = { data: {} }) {
  const get = vi.fn<Get>().mockResolvedValue(read);
  const patch = vi.fn<Patch>(async (_userId, body) => ({
    data: { ...body.settings },
  }));
  const client = { accountSettings: { get, patch } } as unknown as ApiClient;
  return { client, get, patch };
}

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

async function renderSettled(client: ApiClient) {
  const hook = renderHook(() => useAccountSyncArchived(USER, client));
  await flush();
  return hook;
}

async function toggle(result: { current: { toggle: () => void } }) {
  await act(async () => {
    result.current.toggle();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useAccountSyncArchived — reading", () => {
  it.each([
    { cached: "1", shown: BoolFlag.TRUE },
    { cached: "0", shown: BoolFlag.FALSE },
    { cached: "true", shown: BoolFlag.FALSE },
    { cached: null, shown: BoolFlag.FALSE },
  ])(
    "shows the cache $cached as $shown before the server answers",
    async ({ cached, shown }) => {
      if (cached !== null) localStorage.setItem(CACHE_KEY, cached);
      const read = held<ApiResponse<AccountSettings>>();
      const { client, get } = createClient();
      get.mockReturnValueOnce(read.promise);

      const { result } = renderHook(() => useAccountSyncArchived(USER, client));

      expect(result.current.syncArchived).toBe(shown);
      expect(get).toHaveBeenCalledWith(USER);
      await act(async () => {
        read.release({ data: {} });
      });
    },
  );

  it.each([
    { cached: "0", server: BoolFlag.TRUE },
    { cached: "1", server: BoolFlag.FALSE },
  ])(
    "follows the server's $server over the cache $cached and updates the cache",
    async ({ cached, server }) => {
      localStorage.setItem(CACHE_KEY, cached);
      const { client, patch } = createClient({
        data: { syncArchived: server },
      });

      const { result } = await renderSettled(client);

      expect(result.current.syncArchived).toBe(server);
      expect(localStorage.getItem(CACHE_KEY)).toBe(String(server));
      expect(result.current.message).toBe("");
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it("keeps the cached value and sends nothing when the account has no value yet", async () => {
    localStorage.setItem(CACHE_KEY, "1");
    const { client, patch } = createClient({ data: {} });

    const { result } = await renderSettled(client);

    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(localStorage.getItem(CACHE_KEY)).toBe("1");
    expect(patch).not.toHaveBeenCalled();
  });

  it("says the setting stays in this browser and keeps the cache on a 404 read", async () => {
    expect(ACCOUNT_SETTINGS_LOCAL_ONLY).toBe(
      "伺服器尚未支援設定連動，這些設定只存在這個瀏覽器",
    );
    localStorage.setItem(CACHE_KEY, "1");
    const { client } = createClient({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });

    const { result } = await renderSettled(client);

    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(result.current.message).toBe(ACCOUNT_SETTINGS_LOCAL_ONLY);
  });

  it.each([
    {
      name: "an error envelope",
      setUp: (get: ReturnType<typeof vi.fn<Get>>) =>
        get.mockResolvedValueOnce({
          error: { code: "INTERNAL_ERROR", message: "boom" },
        }),
    },
    {
      name: "a rejected request",
      setUp: (get: ReturnType<typeof vi.fn<Get>>) =>
        get.mockRejectedValueOnce(new Error("network")),
    },
  ])("keeps the cache and says nothing on $name", async ({ setUp }) => {
    localStorage.setItem(CACHE_KEY, "1");
    const { client, get } = createClient();
    setUp(get);

    const { result } = await renderSettled(client);

    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(result.current.message).toBe("");
    expect(localStorage.getItem(CACHE_KEY)).toBe("1");
  });

  it("does not throw with a client that has no accountSettings", async () => {
    localStorage.setItem(CACHE_KEY, "1");
    const { result } = await renderSettled({} as unknown as ApiClient);

    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(result.current.message).toBe("");
  });

  it.each([
    { name: "a value", reply: { data: { syncArchived: BoolFlag.FALSE } } },
    {
      name: "a 404",
      reply: { error: { code: "NOT_FOUND", message: "Not Found" } },
    },
  ])(
    "drops a read carrying $name that lands after a toggle",
    async ({ reply }) => {
      const read = held<ApiResponse<AccountSettings>>();
      const { client, get } = createClient();
      get.mockReturnValueOnce(read.promise);
      const { result } = renderHook(() => useAccountSyncArchived(USER, client));

      await toggle(result);
      expect(result.current.syncArchived).toBe(BoolFlag.TRUE);

      await act(async () => {
        read.release(reply as ApiResponse<AccountSettings>);
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
      expect(localStorage.getItem(CACHE_KEY)).toBe("1");
      expect(result.current.message).toBe("");
    },
  );
});

describe("useAccountSyncArchived — toggling", () => {
  it("switches at once, caches it and saves only settings, never ifAbsent", async () => {
    const { client, patch } = createClient();
    const { result } = await renderSettled(client);

    await toggle(result);

    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(localStorage.getItem(CACHE_KEY)).toBe("1");
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(USER, {
      settings: { syncArchived: BoolFlag.TRUE },
    });
    expect(patch.mock.calls[0][1]).not.toHaveProperty("ifAbsent");
    expect(result.current.message).toBe("");
  });

  it.each([
    {
      name: "refuses the save",
      setUp: (patch: ReturnType<typeof vi.fn<Patch>>) =>
        patch.mockResolvedValueOnce({
          error: { code: "RATE_LIMITED", message: "slow down" },
        }),
    },
    {
      name: "cannot be reached",
      setUp: (patch: ReturnType<typeof vi.fn<Patch>>) =>
        patch.mockRejectedValueOnce(new Error("network")),
    },
  ])(
    "switches back — state and cache — with the failure copy when the server $name",
    async ({ setUp }) => {
      expect(ACCOUNT_SETTINGS_SAVE_FAILED).toBe("儲存失敗，請稍後再試");
      const { client, patch } = createClient();
      setUp(patch);
      const { result } = await renderSettled(client);

      await toggle(result);

      expect(result.current.syncArchived).toBe(BoolFlag.FALSE);
      expect(localStorage.getItem(CACHE_KEY)).toBe("0");
      expect(result.current.message).toBe(ACCOUNT_SETTINGS_SAVE_FAILED);
    },
  );

  it("restores the cache when a refused save lands after the page unmounted", async () => {
    const reply = held<ApiResponse<AccountSettings>>();
    const { client, patch } = createClient();
    patch.mockReturnValueOnce(reply.promise);
    const { result, unmount } = await renderSettled(client);

    act(() => {
      result.current.toggle();
    });
    expect(localStorage.getItem(CACHE_KEY)).toBe("1");
    unmount();

    await act(async () => {
      reply.release({ error: { code: "INTERNAL_ERROR", message: "boom" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(localStorage.getItem(CACHE_KEY)).toBe("0");
  });

  it("keeps the change and turns local-only on a 404 save; later toggles send nothing", async () => {
    const { client, patch } = createClient();
    patch.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const { result } = await renderSettled(client);

    await toggle(result);

    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(localStorage.getItem(CACHE_KEY)).toBe("1");
    expect(result.current.message).toBe(ACCOUNT_SETTINGS_LOCAL_ONLY);

    await toggle(result);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(result.current.syncArchived).toBe(BoolFlag.FALSE);
    expect(localStorage.getItem(CACHE_KEY)).toBe("0");
    expect(result.current.message).toBe(ACCOUNT_SETTINGS_LOCAL_ONLY);
  });

  it("toggles locally without a request after a 404 read", async () => {
    const { client, patch } = createClient({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const { result } = await renderSettled(client);

    await toggle(result);

    expect(patch).not.toHaveBeenCalled();
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(localStorage.getItem(CACHE_KEY)).toBe("1");
    expect(result.current.message).toBe(ACCOUNT_SETTINGS_LOCAL_ONLY);
  });

  it("ignores a second toggle while a save is out", async () => {
    const reply = held<ApiResponse<AccountSettings>>();
    const { client, patch } = createClient();
    patch.mockReturnValueOnce(reply.promise);
    const { result } = await renderSettled(client);

    act(() => {
      result.current.toggle();
    });
    act(() => {
      result.current.toggle();
    });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);

    await act(async () => {
      reply.release({ data: { syncArchived: BoolFlag.TRUE } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
    expect(result.current.message).toBe("");
  });

  it("clears an earlier failure copy when the next save starts", async () => {
    const { client, patch } = createClient();
    patch.mockResolvedValueOnce({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    const { result } = await renderSettled(client);
    await toggle(result);
    expect(result.current.message).toBe(ACCOUNT_SETTINGS_SAVE_FAILED);

    await toggle(result);

    expect(result.current.message).toBe("");
    expect(result.current.syncArchived).toBe(BoolFlag.TRUE);
  });
});
