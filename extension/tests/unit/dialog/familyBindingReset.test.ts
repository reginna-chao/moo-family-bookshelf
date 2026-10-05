import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";
import {
  clearStoredFamilyBinding,
  forgetStoredAccount,
} from "@/dialog/familyBindingReset";
import {
  checkAccountIdentity,
  forgetAccountConfirmation,
  markAccountConfirmed,
} from "@/dialog/accountIdentityCheck";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
  USER_EMAIL_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
  API_ENDPOINT_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  DEFAULT_API_ENDPOINT,
} from "@/constants";

/**
 * familyBindingReset: the device-local teardown shared by leaving a family and
 * by "改用這個帳號重新設定" on the account-mismatch screen (issue #271).
 *
 * - forgetStoredAccount drops the binding AND every key naming the old account,
 *   resets the live client, and calls NO API (the old account keeps its family).
 * - clearStoredFamilyBinding alone (leave) must keep the user's own keys:
 *   personal settings persist across families (Invariant 5).
 * - A failed local removal rejects and leaves the client, the stored endpoint
 *   and the page-load confirmation as they were.
 */

const CUSTOM_ENDPOINT = "https://custom.workers.dev";
const OLD_USER = "a".repeat(64);

const ACCOUNT_KEYS = [
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
  USER_EMAIL_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
];

async function seedStoredAccount(): Promise<void> {
  await chrome.storage.local.set({
    [USER_ID_KEY]: OLD_USER,
    [FAMILY_ID_KEY]: "fam-1",
    [AUTH_TOKEN_KEY]: "tok",
    [TOKEN_EXPIRES_AT_KEY]: 123,
    [LAST_SYNC_AT_KEY]: 456,
    [DISPLAY_NAME_KEY]: "Old Account",
    [USER_EMAIL_KEY]: "old@example.com",
    [PERSONAL_BOOKS_CACHE_KEY]: { books: [] },
    [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
    [DECLINED_FAMILY_ENDPOINT_KEY]: { value: null },
    // A device preference, not account data — must survive.
    [AUTO_SYNC_INTERVAL_KEY]: "daily",
  });
  await chrome.storage.sync.set({ [FAMILY_ID_KEY]: "fam-1" });
}

async function storedLocal(): Promise<Record<string, unknown>> {
  return chrome.storage.local.get(null);
}

/**
 * Is `userId` still confirmed for this page load? A cached match answers
 * without navigating; otherwise the pre-aborted check resolves `unknown`.
 */
async function isConfirmed(userId: string): Promise<boolean> {
  const aborted = new AbortController();
  aborted.abort();
  return (await checkAccountIdentity(userId, aborted.signal)) === "match";
}

function makeClient(): ApiClient {
  const client = new ApiClient();
  client.setEndpoint(CUSTOM_ENDPOINT);
  client.setAuthToken("tok");
  return client;
}

describe("familyBindingReset", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    vi.clearAllMocks();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    fetchMock = vi.fn().mockRejectedValue(new Error("no network in tests"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    forgetAccountConfirmation();
    await seedStoredAccount();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    forgetAccountConfirmation();
    vi.mocked(chrome.runtime.sendMessage).mockReset();
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
  });

  describe("forgetStoredAccount", () => {
    it("removes every key that names the old account, plus its endpoint", async () => {
      await forgetStoredAccount(makeClient());

      const local = await storedLocal();
      for (const key of [
        ...ACCOUNT_KEYS,
        API_ENDPOINT_KEY,
        DECLINED_FAMILY_ENDPOINT_KEY,
      ]) {
        expect(local).not.toHaveProperty(key);
      }
      // Positive companion: the store was readable and device prefs survive.
      expect(local).toEqual({ [AUTO_SYNC_INTERVAL_KEY]: "daily" });
      expect(await chrome.storage.sync.get(null)).toEqual({});
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "CLEAR_FAMILY_ID",
      });
    });

    it("resets the live client and calls no API", async () => {
      const client = makeClient();
      const setAuthToken = vi.spyOn(client, "setAuthToken");
      const leaveFamily = vi.spyOn(client, "leaveFamily");

      await forgetStoredAccount(client);

      expect(setAuthToken).toHaveBeenCalledWith(null);
      expect(client.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
      // The old account stays in its family: local reset only.
      expect(leaveFamily).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("drops the page-load account confirmation", async () => {
      markAccountConfirmed(OLD_USER);
      expect(await isConfirmed(OLD_USER)).toBe(true);

      await forgetStoredAccount(makeClient());

      expect(await isConfirmed(OLD_USER)).toBe(false);
    });

    it("rejects and leaves client, endpoint and confirmation alone when the local removal fails", async () => {
      markAccountConfirmed(OLD_USER);
      const client = makeClient();
      const setAuthToken = vi.spyOn(client, "setAuthToken");
      vi.mocked(chrome.storage.local.remove).mockImplementationOnce(() =>
        Promise.reject(new Error("storage unavailable")),
      );

      await expect(forgetStoredAccount(client)).rejects.toThrow(
        "storage unavailable",
      );

      expect(setAuthToken).not.toHaveBeenCalled();
      expect(client.getEndpoint()).toBe(CUSTOM_ENDPOINT);
      expect(await isConfirmed(OLD_USER)).toBe(true);
      // The endpoint choice is only reset once the local removal landed.
      const local = await storedLocal();
      expect(local[USER_ID_KEY]).toBe(OLD_USER);
      expect(local[API_ENDPOINT_KEY]).toBe(CUSTOM_ENDPOINT);
    });
  });

  describe("clearStoredFamilyBinding (leave family)", () => {
    it("removes the family binding but keeps the user's own data", async () => {
      await clearStoredFamilyBinding();

      const local = await storedLocal();
      expect(local).not.toHaveProperty(FAMILY_ID_KEY);
      expect(local).not.toHaveProperty(AUTH_TOKEN_KEY);
      expect(local).not.toHaveProperty(TOKEN_EXPIRES_AT_KEY);
      expect(local).not.toHaveProperty(API_ENDPOINT_KEY);
      expect(local).not.toHaveProperty(DECLINED_FAMILY_ENDPOINT_KEY);
      // Personal settings persist across families (Invariant 5).
      expect(local).toMatchObject({
        [USER_ID_KEY]: OLD_USER,
        [DISPLAY_NAME_KEY]: "Old Account",
        [USER_EMAIL_KEY]: "old@example.com",
        [PERSONAL_BOOKS_CACHE_KEY]: { books: [] },
        [LAST_SYNC_AT_KEY]: 456,
      });
      expect(await chrome.storage.sync.get(null)).toEqual({});
    });

    it("still clears local storage when the background and sync storage fail", async () => {
      vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => {
        throw new Error("Receiving end does not exist.");
      });
      vi.mocked(chrome.storage.sync.remove).mockImplementationOnce(() =>
        Promise.reject(new Error("sync unavailable")),
      );

      await expect(clearStoredFamilyBinding()).resolves.toBeUndefined();

      const local = await storedLocal();
      expect(local).not.toHaveProperty(FAMILY_ID_KEY);
      expect(local).not.toHaveProperty(AUTH_TOKEN_KEY);
    });

    it("starts the local removal synchronously", async () => {
      const pending = clearStoredFamilyBinding();

      expect(chrome.storage.local.remove).toHaveBeenCalledWith([
        FAMILY_ID_KEY,
        AUTH_TOKEN_KEY,
        TOKEN_EXPIRES_AT_KEY,
      ]);
      await pending;
    });
  });
});
