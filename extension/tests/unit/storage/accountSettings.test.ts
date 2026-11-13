import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { ACCOUNT_SETTINGS_FIELDS } from "moo-family-bookshelf-shared/api/accountSettings";
import {
  ACCOUNT_SETTING_KEYS,
  readStoredAccountSettings,
  writeFollowedAccountSettings,
  writeLocalAccountSetting,
} from "@/storage/accountSettings";
import {
  AUTO_SYNC_INTERVAL_KEY,
  FLOATING_ICON_SIZE_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  SYNC_ARCHIVED_KEY,
  USER_ID_KEY,
} from "@/constants";

/**
 * The four account settings (#460) in storage.local (src/storage/accountSettings.ts), the local
 * cache of the server record. Runs against the store-backed mock of tests/setup.ts, cleared around
 * every case. `readStoredAccountSettings` returns ONLY the fields this browser holds a valid value
 * for — no defaults — because that absence is what tells the open-time refresh which settings this
 * browser never adjusted (the `ifAbsent` fill). `writeFollowedAccountSettings` caches the server's
 * values only while the stored userId is still the one the request was for, and writes only the
 * fields that differ, so an unchanged setting fires no `storage.onChanged`.
 */

const USER = "a1b2c3d4e5f60718";

async function stored(): Promise<Record<string, unknown>> {
  return (await chrome.storage.local.get(null)) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ACCOUNT_SETTING_KEYS", () => {
  it("maps every field to its existing storage.local key", () => {
    expect(ACCOUNT_SETTING_KEYS).toEqual({
      syncArchived: SYNC_ARCHIVED_KEY,
      autoSyncInterval: AUTO_SYNC_INTERVAL_KEY,
      storePageChipEnabled: STORE_PAGE_CHIP_ENABLED_KEY,
      floatingIconSize: FLOATING_ICON_SIZE_KEY,
    });
    expect(Object.keys(ACCOUNT_SETTING_KEYS).sort()).toEqual(
      [...ACCOUNT_SETTINGS_FIELDS].sort(),
    );
  });
});

describe("readStoredAccountSettings", () => {
  it("returns {} for an empty store, filling in no defaults", async () => {
    await expect(readStoredAccountSettings()).resolves.toEqual({});
  });

  it("returns every valid stored field from one read", async () => {
    await chrome.storage.local.set({
      [SYNC_ARCHIVED_KEY]: BoolFlag.FALSE,
      [AUTO_SYNC_INTERVAL_KEY]: "never",
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      [FLOATING_ICON_SIZE_KEY]: "icon",
    });
    vi.mocked(chrome.storage.local.get).mockClear();

    await expect(readStoredAccountSettings()).resolves.toEqual({
      syncArchived: BoolFlag.FALSE,
      autoSyncInterval: "never",
      storePageChipEnabled: BoolFlag.TRUE,
      floatingIconSize: "icon",
    });
    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    { key: SYNC_ARCHIVED_KEY, value: true },
    { key: SYNC_ARCHIVED_KEY, value: "1" },
    { key: STORE_PAGE_CHIP_ENABLED_KEY, value: 2 },
    { key: STORE_PAGE_CHIP_ENABLED_KEY, value: null },
    { key: AUTO_SYNC_INTERVAL_KEY, value: "yearly" },
    { key: FLOATING_ICON_SIZE_KEY, value: "MEDIUM" },
  ])("treats $key = $value as never adjusted", async ({ key, value }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // One valid neighbour, so the case shows the invalid field alone is dropped.
    const neighbour: Record<string, unknown> =
      key === FLOATING_ICON_SIZE_KEY
        ? { [AUTO_SYNC_INTERVAL_KEY]: "weekly" }
        : { [FLOATING_ICON_SIZE_KEY]: "small" };
    await chrome.storage.local.set({ [key]: value, ...neighbour });

    await expect(readStoredAccountSettings()).resolves.toEqual(
      key === FLOATING_ICON_SIZE_KEY
        ? { autoSyncInterval: "weekly" }
        : { floatingIconSize: "small" },
    );
  });
});

describe("writeLocalAccountSetting", () => {
  it("writes the one key of the field", async () => {
    await writeLocalAccountSetting("autoSyncInterval", "monthly");

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [AUTO_SYNC_INTERVAL_KEY]: "monthly",
    });
    expect(await stored()).toEqual({ [AUTO_SYNC_INTERVAL_KEY]: "monthly" });
  });
});

describe("writeFollowedAccountSettings", () => {
  it("writes only the fields whose stored value differs, in one set", async () => {
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER,
      [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
      [FLOATING_ICON_SIZE_KEY]: "small",
    });
    vi.mocked(chrome.storage.local.set).mockClear();

    await writeFollowedAccountSettings(USER, {
      syncArchived: BoolFlag.TRUE,
      floatingIconSize: "large",
      autoSyncInterval: "weekly",
    });

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FLOATING_ICON_SIZE_KEY]: "large",
      [AUTO_SYNC_INTERVAL_KEY]: "weekly",
    });
  });

  it("leaves a field absent from the record untouched", async () => {
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER,
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });

    await writeFollowedAccountSettings(USER, { syncArchived: BoolFlag.FALSE });

    const after = await stored();
    expect(after[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.TRUE);
    expect(after[SYNC_ARCHIVED_KEY]).toBe(BoolFlag.FALSE);
  });

  it("writes nothing when every value already matches", async () => {
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER,
      [AUTO_SYNC_INTERVAL_KEY]: "never",
    });
    vi.mocked(chrome.storage.local.set).mockClear();

    await writeFollowedAccountSettings(USER, { autoSyncInterval: "never" });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it.each([
    { name: "another account", binding: { [USER_ID_KEY]: "ffff0000ffff0000" } },
    { name: "no account", binding: {} },
  ])(
    "writes nothing when the stored userId names $name",
    async ({ binding }) => {
      await chrome.storage.local.set(binding);
      vi.mocked(chrome.storage.local.set).mockClear();

      await writeFollowedAccountSettings(USER, { syncArchived: BoolFlag.TRUE });

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
      expect((await stored())[SYNC_ARCHIVED_KEY]).toBeUndefined();
    },
  );
});
