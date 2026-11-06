import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { persistJoinCredentials } from "@/dialog/persistJoinCredentials";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  TOKEN_EXPIRES_AT_KEY,
  USER_ID_KEY,
} from "@/constants";

/**
 * persistJoinCredentials (#456): the only write of a token a create or join just
 * issued, so it decides which server that token is paired with in storage. The pair
 * follows the `endpoint` the caller passes, whatever storage held before: another
 * tab may have moved storage while this tab sat on its onboarding screen.
 *
 * Runs against the store from `tests/setup.ts`, so the end state is read rather than
 * inferred from spies; the spies pin only what the end state cannot show, the number
 * of calls and their order.
 *
 * Why write the pair, then remove the key: the official token goes in one `set` with the
 * official URL, so at no moment can it pair with another server, whatever another tab
 * writes. "No key" is only the resting form of the same pair, which is why a rejected
 * removal is logged, not raised: the pair is right and the join succeeded. A rejected
 * `set` changes nothing.
 *
 * An old expiry stays when the response carries none, on either kind of server; that
 * is a decision, not an oversight, and matches the behaviour before #456.
 */

const CUSTOM_ENDPOINT = "https://family.example";
const OTHER_ENDPOINT = "https://other.example";
const USER = "1".repeat(64);
const FAMILY = "fam-1";
const OLD_TOKEN = "a".repeat(64);
const NEW_TOKEN = "b".repeat(64);
const OLD_EXPIRY = 111;
const NEW_EXPIRY = 222;

const OFFICIAL_REMOVAL = [API_ENDPOINT_KEY];

const PRIOR_PAIR = {
  [API_ENDPOINT_KEY]: OTHER_ENDPOINT,
  [AUTH_TOKEN_KEY]: OLD_TOKEN,
  [TOKEN_EXPIRES_AT_KEY]: OLD_EXPIRY,
};

const IDENTITY = { [USER_ID_KEY]: USER, [FAMILY_ID_KEY]: FAMILY };

const local = vi.mocked(chrome.storage.local);

async function storedRecord(): Promise<Record<string, unknown>> {
  return (await browser.storage.local.get(null)) as Record<string, unknown>;
}

function persistIssued(endpoint: string) {
  return persistJoinCredentials({
    userId: USER,
    familyId: FAMILY,
    authToken: NEW_TOKEN,
    expiresAt: NEW_EXPIRY,
    endpoint,
  });
}

describe("persistJoinCredentials", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await browser.storage.local.clear();
    await browser.storage.local.set(PRIOR_PAIR);
    vi.clearAllMocks();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await browser.storage.local.clear();
  });

  describe("a token issued by the official default", () => {
    it("writes the official URL with the token in one call, then removes the key", async () => {
      await persistIssued(DEFAULT_API_ENDPOINT);

      expect(local.set).toHaveBeenCalledTimes(1);
      expect(local.set.mock.calls[0][0]).toEqual({
        ...IDENTITY,
        [API_ENDPOINT_KEY]: DEFAULT_API_ENDPOINT,
        [AUTH_TOKEN_KEY]: NEW_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: NEW_EXPIRY,
      });
      expect(local.remove).toHaveBeenCalledTimes(1);
      expect(local.remove.mock.calls[0][0]).toEqual(OFFICIAL_REMOVAL);
      expect(local.set.mock.invocationCallOrder[0]).toBeLessThan(
        local.remove.mock.invocationCallOrder[0],
      );
      expect(await storedRecord()).toEqual({
        ...IDENTITY,
        [AUTH_TOKEN_KEY]: NEW_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: NEW_EXPIRY,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("keeps the old expiry when the response carries none", async () => {
      await persistJoinCredentials({
        userId: USER,
        familyId: FAMILY,
        authToken: NEW_TOKEN,
        endpoint: DEFAULT_API_ENDPOINT,
      });

      expect(await storedRecord()).toEqual({
        ...IDENTITY,
        [AUTH_TOKEN_KEY]: NEW_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: OLD_EXPIRY,
      });
    });

    it("resolves and logs when the removal rejects, with the pair still correct", async () => {
      local.remove.mockRejectedValueOnce(new Error("storage unavailable"));

      await expect(
        persistIssued(DEFAULT_API_ENDPOINT),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[persistJoinCredentials] Could not remove the official endpoint key",
        expect.any(Error),
      );
      expect(await storedRecord()).toEqual({
        ...IDENTITY,
        [API_ENDPOINT_KEY]: DEFAULT_API_ENDPOINT,
        [AUTH_TOKEN_KEY]: NEW_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: NEW_EXPIRY,
      });
    });

    it("rejects, removes nothing and leaves the old pair whole when the write rejects", async () => {
      local.set.mockRejectedValueOnce(new Error("storage unavailable"));

      await expect(persistIssued(DEFAULT_API_ENDPOINT)).rejects.toThrow(
        "storage unavailable",
      );

      expect(local.remove).not.toHaveBeenCalled();
      expect(await storedRecord()).toEqual(PRIOR_PAIR);
    });
  });

  describe("a token issued by a custom server", () => {
    it("writes the endpoint and the token in one call, with no removal", async () => {
      await persistIssued(CUSTOM_ENDPOINT);

      expect(local.remove).not.toHaveBeenCalled();
      expect(local.set).toHaveBeenCalledTimes(1);
      expect(local.set.mock.calls[0][0]).toEqual({
        ...IDENTITY,
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
        [AUTH_TOKEN_KEY]: NEW_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: NEW_EXPIRY,
      });
      expect(await storedRecord()).toEqual({
        ...IDENTITY,
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
        [AUTH_TOKEN_KEY]: NEW_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: NEW_EXPIRY,
      });
    });

    it("leaves the old pair whole when the write rejects", async () => {
      local.set.mockRejectedValueOnce(new Error("storage unavailable"));

      await expect(persistIssued(CUSTOM_ENDPOINT)).rejects.toThrow(
        "storage unavailable",
      );

      expect(await storedRecord()).toEqual(PRIOR_PAIR);
    });
  });

  describe("no token issued", () => {
    it.each([
      ["the official default", DEFAULT_API_ENDPOINT],
      ["a custom server", CUSTOM_ENDPOINT],
    ])(
      "touches neither the pair nor its key on %s",
      async (_label, endpoint) => {
        await persistJoinCredentials({
          userId: USER,
          familyId: FAMILY,
          endpoint,
        });

        expect(local.remove).not.toHaveBeenCalled();
        expect(local.set.mock.calls[0][0]).toEqual(IDENTITY);
        expect(await storedRecord()).toEqual({ ...PRIOR_PAIR, ...IDENTITY });
      },
    );
  });
});
