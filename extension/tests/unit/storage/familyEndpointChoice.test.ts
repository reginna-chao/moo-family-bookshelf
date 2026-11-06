import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import {
  persistAcceptedFamilyEndpoint,
  persistSwitchedFamilyEndpoint,
  readDeclinedFamilyEndpoint,
  resetFamilyEndpointChoice,
  saveDeclinedFamilyEndpoint,
} from "@/storage/familyEndpointChoice";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from "@/constants";

/**
 * Storage effects behind the "switch to the family's API endpoint?" decision.
 *
 * ACCEPT persists through a DIRECT storage.local write, the only path: the
 * background has no endpoint handler any more, so nothing is sent to it (the
 * retired message is pinned in tests/unit/background.test.ts). DECLINE must record
 * the refused target so the same value stops re-prompting, while an unreadable store
 * degrades to "nothing declined" — one extra confirmation, never an
 * unconfirmed switch.
 *
 * tests/setup.ts backs `browser.storage.local` with a real in-memory store, so
 * these tests assert on the resulting store contents as well as the calls.
 *
 * A hand-edited / legacy / corrupted declined record must degrade to "nothing
 * declined" so the confirmation prompt reappears instead of a stale marker
 * silently suppressing it.
 *
 * persistSwitchedFamilyEndpoint (#456): adopting another server must not leave the
 * old server's token paired with the new endpoint, so the token goes first, and a
 * storage failure rejects instead of being swallowed. `recordedOps` reads the shared
 * store's own spies, so the order is the one PRODUCTION took and the store contents
 * stay real. A failing last removal rejects with the endpoint already stored. The
 * interleaving with another tab's write-back lands inside the endpoint write, between
 * the two removals.
 *
 * resetFamilyEndpointChoice: leaving a family drops this device's endpoint state
 * entirely. The endpoint is FAMILY-scoped — the owner picks it, every member
 * adopts it — so a family-less client left pointing at the former family's
 * server would send the next create/join there (userId, display name, the token
 * that server issues, the whole personal book list) and bake that host into the
 * sync code it hands out next. The declined marker goes with it: a refusal
 * recorded against the old family must not suppress the prompt for the next one.
 */

const CUSTOM_ENDPOINT = "https://family.example";

async function readRaw(key: string): Promise<unknown> {
  const result = (await browser.storage.local.get([key])) as Record<
    string,
    unknown
  >;
  return result[key];
}

describe("familyEndpointChoice storage", () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  describe("readDeclinedFamilyEndpoint", () => {
    it("returns null when nothing was ever declined", async () => {
      await expect(readDeclinedFamilyEndpoint()).resolves.toBeNull();
    });

    it("round-trips a declined custom endpoint through saveDeclinedFamilyEndpoint", async () => {
      await saveDeclinedFamilyEndpoint({ value: CUSTOM_ENDPOINT });

      await expect(readDeclinedFamilyEndpoint()).resolves.toEqual({
        value: CUSTOM_ENDPOINT,
      });
    });

    it("round-trips a declined revert-to-default (null) so it stays distinguishable from 'no decision'", async () => {
      await saveDeclinedFamilyEndpoint({ value: null });

      await expect(readDeclinedFamilyEndpoint()).resolves.toEqual({
        value: null,
      });
    });

    // A corrupted record degrades to "nothing declined", so the prompt reappears
    // rather than being silently suppressed.
    const malformed: Array<[string, unknown]> = [
      ["a bare string", CUSTOM_ENDPOINT],
      ["a number", 42],
      ["a boolean", true],
      ["an object without `value`", { endpoint: CUSTOM_ENDPOINT }],
      ["an object whose `value` is a number", { value: 42 }],
      ["an object whose `value` is an object", { value: { url: "x" } }],
      ["an array", []],
      ["null", null],
    ];

    it.each(malformed)(
      "degrades to 'nothing declined' when the stored value is %s",
      async (_label, raw) => {
        await browser.storage.local.set({
          [DECLINED_FAMILY_ENDPOINT_KEY]: raw,
        });

        await expect(readDeclinedFamilyEndpoint()).resolves.toBeNull();
      },
    );

    it("returns null when the storage read fails outright", async () => {
      const getSpy = vi
        .spyOn(browser.storage.local, "get")
        .mockRejectedValue(new Error("Extension context invalidated"));

      await expect(readDeclinedFamilyEndpoint()).resolves.toBeNull();

      getSpy.mockRestore();
    });
  });

  describe("saveDeclinedFamilyEndpoint", () => {
    it("writes the refused target under the declined-endpoint key", async () => {
      await saveDeclinedFamilyEndpoint({ value: CUSTOM_ENDPOINT });

      expect(browser.storage.local.set).toHaveBeenCalledWith({
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: CUSTOM_ENDPOINT },
      });
      await expect(readRaw(DECLINED_FAMILY_ENDPOINT_KEY)).resolves.toEqual({
        value: CUSTOM_ENDPOINT,
      });
    });

    it("never touches the active API endpoint", async () => {
      await browser.storage.local.set({ [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT });

      await saveDeclinedFamilyEndpoint({ value: "https://other.example" });

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);
    });

    it("swallows a failing write instead of rejecting", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const setSpy = vi
        .spyOn(browser.storage.local, "set")
        .mockRejectedValue(new Error("storage unavailable"));

      await expect(
        saveDeclinedFamilyEndpoint({ value: CUSTOM_ENDPOINT }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();

      setSpy.mockRestore();
      warn.mockRestore();
    });
  });

  describe("persistAcceptedFamilyEndpoint", () => {
    it("writes a custom endpoint and clears the declined marker", async () => {
      await saveDeclinedFamilyEndpoint({ value: CUSTOM_ENDPOINT });

      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);
      await expect(
        readRaw(DECLINED_FAMILY_ENDPOINT_KEY),
      ).resolves.toBeUndefined();
    });

    it("REMOVES the endpoint key when reverting to the official default", async () => {
      await browser.storage.local.set({ [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT });
      await saveDeclinedFamilyEndpoint({ value: null });
      // Drop the arrange-phase writes so the "no endpoint write" assertion below
      // only sees what persistAcceptedFamilyEndpoint itself did.
      vi.clearAllMocks();

      await persistAcceptedFamilyEndpoint(null);

      // Reverting stores no URL at all — an absent key is what makes the client
      // fall back to DEFAULT_API_ENDPOINT.
      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      await expect(
        readRaw(DECLINED_FAMILY_ENDPOINT_KEY),
      ).resolves.toBeUndefined();
      expect(browser.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
      );
    });

    it("sends no background message: the direct write is the only path", async () => {
      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("resolves, warns and sends no message when the direct write fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const setSpy = vi
        .spyOn(browser.storage.local, "set")
        .mockRejectedValue(new Error("storage unavailable"));

      try {
        await expect(
          persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT),
        ).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
          "[familyEndpointChoice] Failed to persist endpoint",
          expect.any(Error),
        );
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
      } finally {
        setSpy.mockRestore();
        warn.mockRestore();
      }
    });
  });

  // See the header → "persistSwitchedFamilyEndpoint".
  describe("persistSwitchedFamilyEndpoint", () => {
    const OLD_ENDPOINT = "https://old.example";
    const OLD_TOKEN = "a".repeat(64);
    const FIRST_REMOVAL = [
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
      RECOVERY_COOLDOWN_UNTIL_KEY,
    ];
    const SECOND_REMOVAL = [AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY];

    async function seedOldSession(): Promise<void> {
      await browser.storage.local.set({
        [API_ENDPOINT_KEY]: OLD_ENDPOINT,
        [AUTH_TOKEN_KEY]: OLD_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 123,
        [RECOVERY_COOLDOWN_UNTIL_KEY]: Date.now() + 60_000,
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: CUSTOM_ENDPOINT },
      });
      vi.clearAllMocks();
    }

    /** Every storage write in call order, as `remove:<keys>` / `set:<keys>`. */
    function recordedOps(): string[] {
      const named = (name: string, spy: unknown) =>
        vi
          .mocked(spy as (arg: unknown) => unknown)
          .mock.calls.map((call, index) => ({
            order: vi.mocked(spy as (arg: unknown) => unknown).mock
              .invocationCallOrder[index],
            label: describeOp(name, call[0]),
          }));
      return [
        ...named("remove", browser.storage.local.remove),
        ...named("set", browser.storage.local.set),
      ]
        .sort((a, b) => a.order - b.order)
        .map(({ label }) => label);
    }

    function describeOp(name: string, arg: unknown): string {
      const keys = Array.isArray(arg)
        ? (arg as string[])
        : Object.keys(arg as object);
      return `${name}:${keys.join(",")}`;
    }

    const ENDPOINT_WRITE = `set:${API_ENDPOINT_KEY}`;
    const DECLINE_CLEAR = `remove:${DECLINED_FAMILY_ENDPOINT_KEY}`;

    it("removes the token and cooldown, writes the endpoint, removes the token again, and sends no message", async () => {
      await seedOldSession();

      await persistSwitchedFamilyEndpoint(CUSTOM_ENDPOINT);

      expect(recordedOps()).toEqual([
        `remove:${FIRST_REMOVAL.join(",")}`,
        ENDPOINT_WRITE,
        DECLINE_CLEAR,
        `remove:${SECOND_REMOVAL.join(",")}`,
      ]);
      await expect(readRaw(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readRaw(TOKEN_EXPIRES_AT_KEY)).resolves.toBeUndefined();
      await expect(
        readRaw(RECOVERY_COOLDOWN_UNTIL_KEY),
      ).resolves.toBeUndefined();
      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);
      await expect(
        readRaw(DECLINED_FAMILY_ENDPOINT_KEY),
      ).resolves.toBeUndefined();
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("removes the endpoint key on a switch back to the official default", async () => {
      await seedOldSession();

      await persistSwitchedFamilyEndpoint(null);

      expect(recordedOps()).toEqual([
        `remove:${FIRST_REMOVAL.join(",")}`,
        `remove:${API_ENDPOINT_KEY},${DECLINED_FAMILY_ENDPOINT_KEY}`,
        `remove:${SECOND_REMOVAL.join(",")}`,
      ]);
      await expect(readRaw(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("clears a token another tab wrote back between the first removal and the endpoint write", async () => {
      await seedOldSession();
      const realSet = vi.mocked(browser.storage.local.set);
      const storeWrite = realSet.getMockImplementation()!;
      realSet.mockImplementationOnce(async (items) => {
        await storeWrite({ [AUTH_TOKEN_KEY]: OLD_TOKEN });
        await storeWrite(items);
      });

      await persistSwitchedFamilyEndpoint(CUSTOM_ENDPOINT);

      await expect(readRaw(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);
    });

    it("rejects with nothing written when the first removal fails", async () => {
      await seedOldSession();
      vi.mocked(browser.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );

      await expect(
        persistSwitchedFamilyEndpoint(CUSTOM_ENDPOINT),
      ).rejects.toThrow("storage unavailable");

      expect(browser.storage.local.set).not.toHaveBeenCalled();
      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(OLD_ENDPOINT);
    });

    it("rejects when the endpoint write fails, with the token already gone", async () => {
      await seedOldSession();
      vi.mocked(browser.storage.local.set).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );

      await expect(
        persistSwitchedFamilyEndpoint(CUSTOM_ENDPOINT),
      ).rejects.toThrow("storage unavailable");

      await expect(readRaw(AUTH_TOKEN_KEY)).resolves.toBeUndefined();
      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(OLD_ENDPOINT);
    });

    it("rejects when the last removal fails, with the endpoint written", async () => {
      await seedOldSession();
      const realRemove = vi.mocked(browser.storage.local.remove);
      const storeRemove = realRemove.getMockImplementation()!;
      realRemove.mockImplementation(async (keys) => {
        if (
          Array.isArray(keys) &&
          keys.length === SECOND_REMOVAL.length &&
          keys.includes(AUTH_TOKEN_KEY)
        ) {
          throw new Error("storage unavailable");
        }
        await storeRemove(keys);
      });

      try {
        await expect(
          persistSwitchedFamilyEndpoint(CUSTOM_ENDPOINT),
        ).rejects.toThrow("storage unavailable");

        await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);
      } finally {
        realRemove.mockImplementation(storeRemove);
      }
    });
  });

  // Leaving a family drops the FAMILY-scoped endpoint AND the declined marker.
  // See the header → "resetFamilyEndpointChoice".
  describe("resetFamilyEndpointChoice", () => {
    it("drops the accepted endpoint AND the declined marker", async () => {
      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);
      await saveDeclinedFamilyEndpoint({ value: "https://other.example" });

      await resetFamilyEndpointChoice();

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      await expect(
        readRaw(DECLINED_FAMILY_ENDPOINT_KEY),
      ).resolves.toBeUndefined();
    });

    it("leaves the readers reporting a client back on the official default", async () => {
      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);
      await saveDeclinedFamilyEndpoint({ value: null });

      await resetFamilyEndpointChoice();

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      await expect(readDeclinedFamilyEndpoint()).resolves.toBeNull();
    });

    it("reverts by removing the key, storing no URL", async () => {
      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);
      vi.clearAllMocks();

      await resetFamilyEndpointChoice();

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      // Reverting stores no URL at all — the absent key is what makes the
      // client fall back to DEFAULT_API_ENDPOINT.
      expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    // Account deletion reaches this through the same leave handler AFTER a
    // storage.local.clear(), so "nothing stored" must be an ordinary no-op.
    it("is a no-op when this device had no endpoint state", async () => {
      await expect(resetFamilyEndpointChoice()).resolves.toBeUndefined();

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      await expect(readDeclinedFamilyEndpoint()).resolves.toBeNull();
    });

    it("does not reject when the storage removal fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const removeSpy = vi
        .spyOn(browser.storage.local, "remove")
        .mockRejectedValue(new Error("storage unavailable"));

      await expect(resetFamilyEndpointChoice()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalled();

      removeSpy.mockRestore();
      warn.mockRestore();
    });
  });
});
