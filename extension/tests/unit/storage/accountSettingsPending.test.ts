import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  clearPendingAccountSettings,
  readPendingAccountSettings,
  writePendingAccountSetting,
} from "@/storage/accountSettingsPending";
import { ACCOUNT_SETTINGS_PENDING_KEY, USER_ID_KEY } from "@/constants";

/**
 * The pending-upload marker (#460, src/storage/accountSettingsPending.ts): the options page sends
 * no request, so a setting changed there is recorded under `{ userId, settings }` and uploaded by
 * the next Dialog open. Runs against the store-backed mock of tests/setup.ts, cleared around every
 * case. The marker belongs to the stored userId: with none (onboarding unfinished) nothing is
 * recorded, a marker of another account is replaced whole on write and reads as `{}`, and a clear
 * drops only the fields still holding the value that was sent — a value the options page wrote
 * while the upload was out stays for the next one. The key goes once no field is left.
 */

const USER = "a1b2c3d4e5f60718";
const OTHER_USER = "ffffeeee00001111";

async function storedMarker(): Promise<unknown> {
  const stored = await chrome.storage.local.get([ACCOUNT_SETTINGS_PENDING_KEY]);
  return stored[ACCOUNT_SETTINGS_PENDING_KEY];
}

async function seedMarker(value: unknown): Promise<void> {
  await chrome.storage.local.set({ [ACCOUNT_SETTINGS_PENDING_KEY]: value });
  vi.mocked(chrome.storage.local.set).mockClear();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ [USER_ID_KEY]: USER });
  vi.mocked(chrome.storage.local.set).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writePendingAccountSetting", () => {
  it("records the value under the stored userId", async () => {
    await writePendingAccountSetting("storePageChipEnabled", BoolFlag.TRUE);

    expect(await storedMarker()).toEqual({
      userId: USER,
      settings: { storePageChipEnabled: BoolFlag.TRUE },
    });
  });

  it("merges into this account's marker, the newer value of a field winning", async () => {
    await writePendingAccountSetting("storePageChipEnabled", BoolFlag.TRUE);
    await writePendingAccountSetting("autoSyncInterval", "weekly");
    await writePendingAccountSetting("storePageChipEnabled", BoolFlag.FALSE);

    expect(await storedMarker()).toEqual({
      userId: USER,
      settings: {
        storePageChipEnabled: BoolFlag.FALSE,
        autoSyncInterval: "weekly",
      },
    });
  });

  it("replaces another account's marker whole", async () => {
    await seedMarker({
      userId: OTHER_USER,
      settings: { autoSyncInterval: "never" },
    });

    await writePendingAccountSetting("storePageChipEnabled", BoolFlag.TRUE);

    expect(await storedMarker()).toEqual({
      userId: USER,
      settings: { storePageChipEnabled: BoolFlag.TRUE },
    });
  });

  it.each([
    { name: "no stored userId", binding: undefined },
    { name: "an empty stored userId", binding: "" },
  ])("records nothing with $name", async ({ binding }) => {
    await chrome.storage.local.clear();
    if (binding !== undefined) {
      await chrome.storage.local.set({ [USER_ID_KEY]: binding });
    }
    vi.mocked(chrome.storage.local.set).mockClear();

    await writePendingAccountSetting("storePageChipEnabled", BoolFlag.TRUE);

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(await storedMarker()).toBeUndefined();
  });
});

describe("readPendingAccountSettings", () => {
  it("returns this account's pending values", async () => {
    await seedMarker({
      userId: USER,
      settings: { floatingIconSize: "large" },
    });

    await expect(readPendingAccountSettings(USER)).resolves.toEqual({
      floatingIconSize: "large",
    });
  });

  it.each([
    { name: "absent", value: undefined },
    {
      name: "another account's",
      value: { userId: OTHER_USER, settings: { syncArchived: 1 } },
    },
    { name: "not an object", value: "pending" },
    { name: "without a userId", value: { settings: { syncArchived: 1 } } },
    {
      name: "with an empty userId",
      value: { userId: "", settings: { syncArchived: 1 } },
    },
  ])("returns {} for a marker that is $name", async ({ value }) => {
    if (value !== undefined) await seedMarker(value);

    await expect(readPendingAccountSettings(USER)).resolves.toEqual({});
  });

  it("drops a field whose value is not valid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedMarker({
      userId: USER,
      settings: { syncArchived: true, autoSyncInterval: "weekly" },
    });

    await expect(readPendingAccountSettings(USER)).resolves.toEqual({
      autoSyncInterval: "weekly",
    });
  });
});

describe("clearPendingAccountSettings", () => {
  it("drops only the fields still holding the sent value", async () => {
    await seedMarker({
      userId: USER,
      settings: {
        storePageChipEnabled: BoolFlag.TRUE,
        autoSyncInterval: "weekly",
      },
    });

    // The options page rewrote autoSyncInterval after "daily" was read and sent.
    await clearPendingAccountSettings(USER, {
      storePageChipEnabled: BoolFlag.TRUE,
      autoSyncInterval: "daily",
    });

    expect(await storedMarker()).toEqual({
      userId: USER,
      settings: { autoSyncInterval: "weekly" },
    });
  });

  it("removes the key once no field is left", async () => {
    await seedMarker({
      userId: USER,
      settings: { storePageChipEnabled: BoolFlag.TRUE },
    });

    await clearPendingAccountSettings(USER, {
      storePageChipEnabled: BoolFlag.TRUE,
    });

    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      ACCOUNT_SETTINGS_PENDING_KEY,
    );
    expect(await storedMarker()).toBeUndefined();
  });

  it("writes nothing when no field matches", async () => {
    await seedMarker({
      userId: USER,
      settings: { storePageChipEnabled: BoolFlag.TRUE },
    });

    await clearPendingAccountSettings(USER, {
      storePageChipEnabled: BoolFlag.FALSE,
    });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it("leaves another account's marker alone", async () => {
    const other = {
      userId: OTHER_USER,
      settings: { storePageChipEnabled: BoolFlag.TRUE },
    };
    await seedMarker(other);

    await clearPendingAccountSettings(USER, {
      storePageChipEnabled: BoolFlag.TRUE,
    });

    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    expect(await storedMarker()).toEqual(other);
  });
});
