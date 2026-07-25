import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { migrateStorageKeys } from "@/storage/migrate";
import {
  STORAGE_MIGRATED_KEY,
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  FAMILY_ID_KEY,
  DISPLAY_NAME_KEY,
  FLOATING_ICON_SIZE_KEY,
  LAST_SYNC_AT_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
  seenKey,
  chipsKey,
} from "@/constants";

// Legacy (pre-`moo:`) key forms. These are historical literals baked into the
// migration contract — they intentionally never change. The NEW key for each is
// asserted via the imported constant, so the test breaks if a prefix changes.
const LEGACY_USER_ID = "userId";
const LEGACY_AUTH_TOKEN = "authToken";
const LEGACY_FAMILY_ID = "familyId";
const LEGACY_DISPLAY_NAME = "displayName";
const LEGACY_FLOATING_ICON_SIZE = "floatingIconSize";
const LEGACY_LAST_SYNC_AT = "lastSyncAt";
const LEGACY_PERSONAL_BOOKS_CACHE = "personalBooksCache";

const USER = "abc123";
const LEGACY_SEEN = `familyBookshelfSeen:${USER}`;
const LEGACY_CHIPS = `familyBookshelfChips:${USER}`;

describe("migrateStorageKeys", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renames legacy local + sync keys to the moo: namespace, preserving values", async () => {
    await chrome.storage.local.set({
      [LEGACY_USER_ID]: "user-1",
      [LEGACY_AUTH_TOKEN]: "token-xyz",
    });
    await chrome.storage.sync.set({
      [LEGACY_FAMILY_ID]: "fam-1",
      [LEGACY_DISPLAY_NAME]: "小明",
    });

    await migrateStorageKeys();

    const local = await chrome.storage.local.get(null);
    const sync = await chrome.storage.sync.get(null);

    // New keys hold the original values
    expect(local[USER_ID_KEY]).toBe("user-1");
    expect(local[AUTH_TOKEN_KEY]).toBe("token-xyz");
    expect(sync[FAMILY_ID_KEY]).toBe("fam-1");
    expect(sync[DISPLAY_NAME_KEY]).toBe("小明");

    // Old keys are gone
    expect(LEGACY_USER_ID in local).toBe(false);
    expect(LEGACY_AUTH_TOKEN in local).toBe(false);
    expect(LEGACY_FAMILY_ID in sync).toBe(false);
    expect(LEGACY_DISPLAY_NAME in sync).toBe(false);
  });

  it("sets the migration flag after a successful run", async () => {
    await chrome.storage.local.set({ [LEGACY_USER_ID]: "user-1" });

    await migrateStorageKeys();

    const local = await chrome.storage.local.get(STORAGE_MIGRATED_KEY);
    expect(local[STORAGE_MIGRATED_KEY]).toBe(true);
  });

  it("is a no-op when the migration flag is already set", async () => {
    await chrome.storage.local.set({
      [STORAGE_MIGRATED_KEY]: true,
      [LEGACY_USER_ID]: "stale-legacy",
    });
    vi.clearAllMocks();

    await migrateStorageKeys();

    // No data writes/removes happened — legacy key remains untouched and no moo: key was created.
    const local = await chrome.storage.local.get(null);
    expect(local[LEGACY_USER_ID]).toBe("stale-legacy");
    expect(USER_ID_KEY in local).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it("leaves already-prefixed keys untouched (no double-prefix, no removal)", async () => {
    await chrome.storage.local.set({ [USER_ID_KEY]: "already-migrated" });

    await migrateStorageKeys();

    const local = await chrome.storage.local.get(null);
    expect(local[USER_ID_KEY]).toBe("already-migrated");
    // No double-prefixed key like moo:moo:userId
    expect(`${"moo:"}${USER_ID_KEY}` in local).toBe(false);
  });

  it("preserves unknown keys that are neither legacy static nor legacy dynamic", async () => {
    await chrome.storage.local.set({
      someThirdPartyKey: "keep-me",
      [LEGACY_USER_ID]: "user-1",
    });

    await migrateStorageKeys();

    const local = await chrome.storage.local.get(null);
    expect(local.someThirdPartyKey).toBe("keep-me");
    expect("moo:someThirdPartyKey" in local).toBe(false);
    // The legacy key alongside it still migrated correctly
    expect(local[USER_ID_KEY]).toBe("user-1");
  });

  it("does not clobber an existing new-namespace value with a stale legacy one (retry after partial run)", async () => {
    // Simulates: a prior partial migration left the legacy key behind, then the
    // app wrote a FRESH value under the new key. A retry must keep the fresh
    // new value and merely drop the stale legacy key.
    await chrome.storage.local.set({
      [LEGACY_FAMILY_ID]: "stale-old-family",
      [FAMILY_ID_KEY]: "fresh-new-family",
    });

    await migrateStorageKeys();

    const local = await chrome.storage.local.get(null);
    expect(local[FAMILY_ID_KEY]).toBe("fresh-new-family"); // not reverted
    expect(LEGACY_FAMILY_ID in local).toBe(false); // legacy dropped
  });

  it("migrates dynamic per-user keys (seen / chips)", async () => {
    const seenValue = {
      [USER]: { lastUpdated: "2025-01-01", bookIds: ["b1"] },
    };
    const chipsValue = { bookIds: ["b1"], expiresAt: "2025-01-02" };
    await chrome.storage.local.set({
      [LEGACY_SEEN]: seenValue,
      [LEGACY_CHIPS]: chipsValue,
    });

    await migrateStorageKeys();

    const local = await chrome.storage.local.get(null);
    expect(local[seenKey(USER)]).toEqual(seenValue);
    expect(local[chipsKey(USER)]).toEqual(chipsValue);
    expect(LEGACY_SEEN in local).toBe(false);
    expect(LEGACY_CHIPS in local).toBe(false);
  });

  it("still completes local migration and sets the flag when sync storage is unavailable", async () => {
    await chrome.storage.local.set({ [LEGACY_USER_ID]: "user-1" });
    // Simulate sync storage being unavailable: get(null) rejects.
    vi.mocked(chrome.storage.sync.get).mockRejectedValueOnce(
      new Error("sync unavailable"),
    );

    await expect(migrateStorageKeys()).resolves.toBeUndefined();

    const local = await chrome.storage.local.get(null);
    expect(local[USER_ID_KEY]).toBe("user-1");
    expect(local[STORAGE_MIGRATED_KEY]).toBe(true);
  });

  it("preserves non-string values (numbers, objects) unchanged", async () => {
    const now = 1_700_000_000_000;
    const cachePayload = JSON.stringify([{ bookId: "b1", isShared: 1 }]);
    await chrome.storage.local.set({
      [LEGACY_LAST_SYNC_AT]: now,
      [LEGACY_PERSONAL_BOOKS_CACHE]: cachePayload,
    });

    await migrateStorageKeys();

    const local = await chrome.storage.local.get(null);
    expect(local[LAST_SYNC_AT_KEY]).toBe(now);
    expect(typeof local[LAST_SYNC_AT_KEY]).toBe("number");
    expect(local[PERSONAL_BOOKS_CACHE_KEY]).toBe(cachePayload);
  });

  it("is safe to run twice (second run is a no-op via the flag)", async () => {
    await chrome.storage.local.set({ [LEGACY_FLOATING_ICON_SIZE]: "large" });

    await migrateStorageKeys();
    await migrateStorageKeys();

    const local = await chrome.storage.local.get(null);
    expect(local[FLOATING_ICON_SIZE_KEY]).toBe("large");
    expect(LEGACY_FLOATING_ICON_SIZE in local).toBe(false);
  });
});
