import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import {
  FAMILY_ENDPOINT_CHOICE_KEYS,
  persistAcceptedFamilyEndpoint,
  persistConfirmedFamilyEndpoint,
  persistSwitchedFamilyEndpoint,
  readDeclinedFamilyEndpoint,
  resetFamilyEndpointChoice,
  saveDeclinedFamilyEndpoint,
  storedFamilyIdIs,
} from "@/storage/familyEndpointChoice";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  FAMILY_ID_KEY,
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
 * storedFamilyIdIs (#498): the check a confirmed switch runs BEFORE it writes anything. Only an
 * exact match with the screen's familyId passes; another family, no family, a non-string value and
 * an unreadable store all read as `false`, so the caller refuses with nothing written.
 *
 * persistConfirmedFamilyEndpoint (#498): runs persistSwitchedFamilyEndpoint, then re-reads the
 * familyId, endpoint and token with a read that REJECTS on failure (a failed read must never look
 * like a lost binding and trigger a removal). The family still bound → `"switched"`, nothing more
 * written. Otherwise `"bindingGone"`, and only storage that still holds this write's endpoint with
 * no token is undone — endpoint, declined marker and token keys in ONE removal, so a self-hosted
 * token is never left without its endpoint. A token present means another tab wrote its own set
 * after this write's last token removal (its endpoint may even equal this target), and a `null`
 * target left no endpoint to undo: then nothing is written. The other tab's write is landed by
 * `landBeforeReRead` through the store's own writers, so it is not recorded as a production call;
 * that is "after this write completed, before the re-read".
 *
 * resetFamilyEndpointChoice: drops this device's endpoint state entirely. Only
 * `dialog/useReauth.ts`'s catch path uses it, after `clearFamilyStorage` rejects;
 * leaving a family and being removed instead fold `FAMILY_ENDPOINT_CHOICE_KEYS`
 * into the teardown's own single removal (#492). The endpoint is FAMILY-scoped — the owner picks it, every member
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

  // See the header → "storedFamilyIdIs".
  describe("storedFamilyIdIs", () => {
    const CASES: Array<{
      name: string;
      stored: Record<string, unknown>;
      expected: boolean;
    }> = [
      {
        name: "the same family",
        stored: { [FAMILY_ID_KEY]: "fam-1" },
        expected: true,
      },
      {
        name: "another family",
        stored: { [FAMILY_ID_KEY]: "fam-2" },
        expected: false,
      },
      { name: "no family", stored: {}, expected: false },
      {
        name: "a non-string value",
        stored: { [FAMILY_ID_KEY]: 1 },
        expected: false,
      },
    ];

    it.each(CASES)(
      "returns $expected, writing nothing, when storage binds $name",
      async ({ stored, expected }) => {
        await browser.storage.local.set(stored);
        vi.clearAllMocks();

        await expect(storedFamilyIdIs("fam-1")).resolves.toBe(expected);

        expect(browser.storage.local.get).toHaveBeenCalledWith([FAMILY_ID_KEY]);
        expect(browser.storage.local.set).not.toHaveBeenCalled();
        expect(browser.storage.local.remove).not.toHaveBeenCalled();
      },
    );

    it("returns false when the storage read fails", async () => {
      await browser.storage.local.set({ [FAMILY_ID_KEY]: "fam-1" });
      vi.mocked(browser.storage.local.get).mockRejectedValueOnce(
        new Error("Extension context invalidated"),
      );

      await expect(storedFamilyIdIs("fam-1")).resolves.toBe(false);
    });
  });

  // See the header → "persistConfirmedFamilyEndpoint".
  describe("persistConfirmedFamilyEndpoint", () => {
    const FAMILY_ID = "fam-1";
    const OTHER_FAMILY = "fam-2";
    const OLD_ENDPOINT = "https://old.example";
    const OTHER_ENDPOINT = "https://other-family.example";
    const OLD_TOKEN = "a".repeat(64);
    const OTHER_TOKEN = "b".repeat(64);
    const RE_READ_KEYS = [FAMILY_ID_KEY, API_ENDPOINT_KEY, AUTH_TOKEN_KEY];
    const RE_READ = `get:${RE_READ_KEYS.join(",")}`;
    const UNDO = `remove:${[
      ...FAMILY_ENDPOINT_CHOICE_KEYS,
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
    ].join(",")}`;
    const INSPECTED_KEYS = [
      FAMILY_ID_KEY,
      API_ENDPOINT_KEY,
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
      DECLINED_FAMILY_ENDPOINT_KEY,
    ];
    /** The shared store's own reader / writers: what another tab's write goes through, unrecorded. */
    const storeGet = vi
      .mocked(browser.storage.local.get)
      .getMockImplementation()!;
    const storeSet = vi
      .mocked(browser.storage.local.set)
      .getMockImplementation()!;
    const storeRemove = vi
      .mocked(browser.storage.local.remove)
      .getMockImplementation()!;

    afterEach(() => {
      vi.mocked(browser.storage.local.get).mockImplementation(storeGet);
      vi.mocked(browser.storage.local.remove).mockImplementation(storeRemove);
    });

    async function seedBoundSession(): Promise<void> {
      await browser.storage.local.set({
        [FAMILY_ID_KEY]: FAMILY_ID,
        [API_ENDPOINT_KEY]: OLD_ENDPOINT,
        [AUTH_TOKEN_KEY]: OLD_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 123,
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: CUSTOM_ENDPOINT },
      });
      vi.clearAllMocks();
    }

    function isReRead(keys: unknown): boolean {
      return (
        Array.isArray(keys) &&
        keys.length === RE_READ_KEYS.length &&
        RE_READ_KEYS.every((key) => keys.includes(key))
      );
    }

    /** Lands `write` on the real store just before the re-read after the switch write. */
    function landBeforeReRead(write: () => Promise<unknown>): void {
      vi.mocked(browser.storage.local.get).mockImplementation(async (keys) => {
        if (isReRead(keys)) await write();
        return storeGet(keys);
      });
    }

    /** Every storage call in call order, as `get:` / `set:` / `remove:<keys>`. */
    function storageOps(): string[] {
      const named = (name: string, spy: unknown) => {
        const mock = vi.mocked(spy as (arg: unknown) => unknown).mock;
        return mock.calls.map((call, index) => {
          const arg = call[0];
          const keys = Array.isArray(arg)
            ? (arg as string[])
            : Object.keys(arg as object);
          return {
            order: mock.invocationCallOrder[index],
            label: `${name}:${keys.join(",")}`,
          };
        });
      };
      return [
        ...named("get", browser.storage.local.get),
        ...named("set", browser.storage.local.set),
        ...named("remove", browser.storage.local.remove),
      ]
        .sort((a, b) => a.order - b.order)
        .map(({ label }) => label);
    }

    function opsFromReRead(): string[] {
      const ops = storageOps();
      return ops.slice(ops.indexOf(RE_READ));
    }

    async function inspect(): Promise<Record<string, unknown>> {
      return (await storeGet(INSPECTED_KEYS)) as Record<string, unknown>;
    }

    it("resolves switched, writing nothing after the re-read, while storage still binds the family", async () => {
      await seedBoundSession();

      await expect(
        persistConfirmedFamilyEndpoint(CUSTOM_ENDPOINT, FAMILY_ID),
      ).resolves.toBe("switched");

      expect(storageOps()).toEqual([
        `remove:${AUTH_TOKEN_KEY},${TOKEN_EXPIRES_AT_KEY},${RECOVERY_COOLDOWN_UNTIL_KEY}`,
        `set:${API_ENDPOINT_KEY}`,
        `remove:${DECLINED_FAMILY_ENDPOINT_KEY}`,
        `remove:${AUTH_TOKEN_KEY},${TOKEN_EXPIRES_AT_KEY}`,
        RE_READ,
      ]);
      await expect(inspect()).resolves.toEqual({
        [FAMILY_ID_KEY]: FAMILY_ID,
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
      });
    });

    it("resolves switched on a revert to the official default", async () => {
      await seedBoundSession();

      await expect(
        persistConfirmedFamilyEndpoint(null, FAMILY_ID),
      ).resolves.toBe("switched");

      expect(opsFromReRead()).toEqual([RE_READ]);
      await expect(inspect()).resolves.toEqual({ [FAMILY_ID_KEY]: FAMILY_ID });
    });

    // See the header → "persistConfirmedFamilyEndpoint". `after` lists the five inspected keys.
    const MISMATCHES: Array<{
      name: string;
      target: string | null;
      write: () => Promise<unknown>;
      undone: boolean;
      after: Record<string, unknown>;
    }> = [
      {
        name: "5a: family gone, own endpoint, no token",
        target: CUSTOM_ENDPOINT,
        write: () => storeRemove([FAMILY_ID_KEY]),
        undone: true,
        after: {},
      },
      {
        name: "fam-2 bound, own endpoint, no token",
        target: CUSTOM_ENDPOINT,
        write: () => storeSet({ [FAMILY_ID_KEY]: OTHER_FAMILY }),
        undone: true,
        after: { [FAMILY_ID_KEY]: OTHER_FAMILY },
      },
      {
        name: "5b: join landed with its own endpoint",
        target: CUSTOM_ENDPOINT,
        write: () =>
          storeSet({
            [FAMILY_ID_KEY]: OTHER_FAMILY,
            [AUTH_TOKEN_KEY]: OTHER_TOKEN,
            [TOKEN_EXPIRES_AT_KEY]: 456,
            [API_ENDPOINT_KEY]: OTHER_ENDPOINT,
          }),
        undone: false,
        after: {
          [FAMILY_ID_KEY]: OTHER_FAMILY,
          [AUTH_TOKEN_KEY]: OTHER_TOKEN,
          [TOKEN_EXPIRES_AT_KEY]: 456,
          [API_ENDPOINT_KEY]: OTHER_ENDPOINT,
        },
      },
      {
        name: "5e: join landed on this same endpoint",
        target: CUSTOM_ENDPOINT,
        write: () =>
          storeSet({
            [FAMILY_ID_KEY]: OTHER_FAMILY,
            [AUTH_TOKEN_KEY]: OTHER_TOKEN,
            [TOKEN_EXPIRES_AT_KEY]: 456,
            [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
          }),
        undone: false,
        after: {
          [FAMILY_ID_KEY]: OTHER_FAMILY,
          [AUTH_TOKEN_KEY]: OTHER_TOKEN,
          [TOKEN_EXPIRES_AT_KEY]: 456,
          [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
        },
      },
      {
        name: "family gone, endpoint replaced",
        target: CUSTOM_ENDPOINT,
        write: async () => {
          await storeRemove([FAMILY_ID_KEY]);
          await storeSet({ [API_ENDPOINT_KEY]: OTHER_ENDPOINT });
        },
        undone: false,
        after: { [API_ENDPOINT_KEY]: OTHER_ENDPOINT },
      },
      {
        name: "family gone, own endpoint, a token back",
        target: CUSTOM_ENDPOINT,
        write: async () => {
          await storeRemove([FAMILY_ID_KEY]);
          await storeSet({ [AUTH_TOKEN_KEY]: OTHER_TOKEN });
        },
        undone: false,
        after: {
          [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
          [AUTH_TOKEN_KEY]: OTHER_TOKEN,
        },
      },
      {
        name: "5c: revert to default, family gone",
        target: null,
        write: () => storeRemove([FAMILY_ID_KEY]),
        undone: false,
        after: {},
      },
    ];

    it.each(MISMATCHES)(
      "resolves bindingGone when $name",
      async ({ target, write, undone, after }) => {
        await seedBoundSession();
        landBeforeReRead(write);

        await expect(
          persistConfirmedFamilyEndpoint(target, FAMILY_ID),
        ).resolves.toBe("bindingGone");

        expect(opsFromReRead()).toEqual(undone ? [RE_READ, UNDO] : [RE_READ]);
        await expect(inspect()).resolves.toEqual(after);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
      },
    );

    it("rejects with no removal, leaving the written endpoint, when the re-read fails (5d)", async () => {
      await seedBoundSession();
      vi.mocked(browser.storage.local.get).mockImplementation(async (keys) => {
        if (isReRead(keys)) throw new Error("storage unavailable");
        return storeGet(keys);
      });

      await expect(
        persistConfirmedFamilyEndpoint(CUSTOM_ENDPOINT, FAMILY_ID),
      ).rejects.toThrow("storage unavailable");

      expect(opsFromReRead()).toEqual([RE_READ]);
      await expect(inspect()).resolves.toEqual({
        [FAMILY_ID_KEY]: FAMILY_ID,
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
      });
    });

    it("rejects without the re-read when the switch write fails", async () => {
      await seedBoundSession();
      vi.mocked(browser.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );

      await expect(
        persistConfirmedFamilyEndpoint(CUSTOM_ENDPOINT, FAMILY_ID),
      ).rejects.toThrow("storage unavailable");

      expect(browser.storage.local.get).not.toHaveBeenCalled();
      expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    it("rejects when the undo removal fails", async () => {
      await seedBoundSession();
      landBeforeReRead(() => storeRemove([FAMILY_ID_KEY]));
      vi.mocked(browser.storage.local.remove).mockImplementation(
        async (keys) => {
          if (Array.isArray(keys) && keys.includes(API_ENDPOINT_KEY)) {
            throw new Error("storage unavailable");
          }
          await storeRemove(keys);
        },
      );

      await expect(
        persistConfirmedFamilyEndpoint(CUSTOM_ENDPOINT, FAMILY_ID),
      ).rejects.toThrow("storage unavailable");

      expect(opsFromReRead()).toEqual([RE_READ, UNDO]);
    });
  });

  // The useReauth catch-path reset: drops the FAMILY-scoped endpoint AND the declined marker.
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

    // A reset may find no endpoint state at all (e.g. this device never switched
    // servers), so "nothing stored" must be an ordinary no-op.
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
