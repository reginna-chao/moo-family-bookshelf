import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import {
  persistAcceptedFamilyEndpoint,
  readDeclinedFamilyEndpoint,
  readStoredApiEndpoint,
  resetFamilyEndpointChoice,
  saveDeclinedFamilyEndpoint,
} from "@/storage/familyEndpointChoice";
import { API_ENDPOINT_KEY, DECLINED_FAMILY_ENDPOINT_KEY } from "@/constants";

/**
 * Storage effects behind the "switch to the family's API endpoint?" decision.
 *
 * ACCEPT must persist through a DIRECT storage.local write (authoritative, so
 * the choice survives Firefox's sleeping background page) and only then send
 * the best-effort SET_API_ENDPOINT message. DECLINE must record the refused
 * target so the same value stops re-prompting, while an unreadable store
 * degrades to "nothing declined" — one extra confirmation, never an
 * unconfirmed switch.
 *
 * tests/setup.ts backs `browser.storage.local` with a real in-memory store, so
 * these tests assert on the resulting store contents as well as the calls.
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

    // A hand-edited / legacy / corrupted record must degrade to "nothing
    // declined" so the confirmation prompt reappears instead of a stale marker
    // silently suppressing it.
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

  /**
   * The dialog boots on this value. App reads it DIRECTLY (dialog/App.tsx) —
   * the GET_API_ENDPOINT round-trip has the same Firefox failure mode as the
   * write, where a sleeping background page would silently boot a member who
   * accepted a custom endpoint onto the official default instead.
   */
  describe("readStoredApiEndpoint", () => {
    it("returns null when this device has accepted no custom endpoint", async () => {
      await expect(readStoredApiEndpoint()).resolves.toBeNull();
    });

    it("returns the endpoint an accepted switch persisted", async () => {
      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);

      await expect(readStoredApiEndpoint()).resolves.toBe(CUSTOM_ENDPOINT);
    });

    it("returns null again after a revert to the official default", async () => {
      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);
      await persistAcceptedFamilyEndpoint(null);

      await expect(readStoredApiEndpoint()).resolves.toBeNull();
    });

    it("trims surrounding whitespace off a stored endpoint", async () => {
      await browser.storage.local.set({
        [API_ENDPOINT_KEY]: `  ${CUSTOM_ENDPOINT}  `,
      });

      await expect(readStoredApiEndpoint()).resolves.toBe(CUSTOM_ENDPOINT);
    });

    // "Nothing stored" is the only safe reading of a value that is not a usable
    // URL string — the caller then stays on the official default.
    const unusable: Array<[string, unknown]> = [
      ["an empty string", ""],
      ["a whitespace-only string", "   "],
      ["a number", 42],
      ["a boolean", true],
      ["null", null],
      ["an object", { url: CUSTOM_ENDPOINT }],
      ["an array", [CUSTOM_ENDPOINT]],
    ];

    it.each(unusable)(
      "returns null when the stored value is %s",
      async (_label, raw) => {
        await browser.storage.local.set({ [API_ENDPOINT_KEY]: raw });

        await expect(readStoredApiEndpoint()).resolves.toBeNull();
      },
    );

    // URL validation belongs to ApiClient.setEndpoint; duplicating the rules
    // here would let the two drift. The boot caller guards the throw instead.
    it("hands back a stored string verbatim without judging the URL", async () => {
      await browser.storage.local.set({
        [API_ENDPOINT_KEY]: "http://evil.example.com",
      });

      await expect(readStoredApiEndpoint()).resolves.toBe(
        "http://evil.example.com",
      );
    });

    it("does not mistake a recorded decline for an accepted endpoint", async () => {
      await saveDeclinedFamilyEndpoint({ value: CUSTOM_ENDPOINT });

      await expect(readStoredApiEndpoint()).resolves.toBeNull();
    });

    it("returns null when the storage read fails outright", async () => {
      const getSpy = vi
        .spyOn(browser.storage.local, "get")
        .mockRejectedValue(new Error("Extension context invalidated"));

      await expect(readStoredApiEndpoint()).resolves.toBeNull();

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
    it("writes a custom endpoint, clears the declined marker, and notifies the background", async () => {
      await saveDeclinedFamilyEndpoint({ value: CUSTOM_ENDPOINT });

      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);
      await expect(
        readRaw(DECLINED_FAMILY_ENDPOINT_KEY),
      ).resolves.toBeUndefined();
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_API_ENDPOINT",
        apiEndpoint: CUSTOM_ENDPOINT,
      });
    });

    it("REMOVES the endpoint key when reverting to the official default", async () => {
      await browser.storage.local.set({ [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT });
      await saveDeclinedFamilyEndpoint({ value: null });
      // Drop the arrange-phase writes so the "no endpoint write" assertion below
      // only sees what persistAcceptedFamilyEndpoint itself did.
      vi.clearAllMocks();

      await persistAcceptedFamilyEndpoint(null);

      // Reverting stores no URL at all — an absent key is what makes the client
      // fall back to DEFAULT_API_ENDPOINT (mirrors handleSetApiEndpoint).
      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBeUndefined();
      await expect(
        readRaw(DECLINED_FAMILY_ENDPOINT_KEY),
      ).resolves.toBeUndefined();
      expect(browser.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
      );
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_API_ENDPOINT",
        apiEndpoint: null,
      });
    });

    it("keeps the direct write authoritative when the background message rejects (Firefox asleep)", async () => {
      vi.mocked(browser.runtime.sendMessage).mockImplementation((() =>
        Promise.reject(
          new Error("Could not establish connection."),
        )) as typeof browser.runtime.sendMessage);

      await expect(
        persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT),
      ).resolves.toBeUndefined();

      await expect(readRaw(API_ENDPOINT_KEY)).resolves.toBe(CUSTOM_ENDPOINT);

      // Restore the shared spy to its inert setup.ts state for sibling tests.
      vi.mocked(browser.runtime.sendMessage).mockReset();
    });

    it("still notifies the background when the direct write fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const setSpy = vi
        .spyOn(browser.storage.local, "set")
        .mockRejectedValue(new Error("storage unavailable"));

      await expect(
        persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalled();
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_API_ENDPOINT",
        apiEndpoint: CUSTOM_ENDPOINT,
      });

      setSpy.mockRestore();
      warn.mockRestore();
    });
  });

  /**
   * Leaving a family drops this device's endpoint state entirely. The endpoint
   * is FAMILY-scoped — the owner picks it, every member adopts it — so a
   * family-less client left pointing at the former family's server would send
   * the next create/join there (userId, display name, the token that server
   * issues, the whole personal book list) and bake that host into the sync code
   * it hands out next. The declined marker goes with it: a refusal recorded
   * against the old family must not suppress the prompt for the next one.
   */
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

      await expect(readStoredApiEndpoint()).resolves.toBeNull();
      await expect(readDeclinedFamilyEndpoint()).resolves.toBeNull();
    });

    it("tells the background to revert too", async () => {
      await persistAcceptedFamilyEndpoint(CUSTOM_ENDPOINT);
      vi.clearAllMocks();

      await resetFamilyEndpointChoice();

      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_API_ENDPOINT",
        apiEndpoint: null,
      });
      // Reverting stores no URL at all — the absent key is what makes the
      // client fall back to DEFAULT_API_ENDPOINT.
      expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    // Account deletion reaches this through the same leave handler AFTER a
    // storage.local.clear(), so "nothing stored" must be an ordinary no-op.
    it("is a no-op when this device had no endpoint state", async () => {
      await expect(resetFamilyEndpointChoice()).resolves.toBeUndefined();

      await expect(readStoredApiEndpoint()).resolves.toBeNull();
      await expect(readDeclinedFamilyEndpoint()).resolves.toBeNull();
    });

    it("does not reject when the storage removal fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const removeSpy = vi
        .spyOn(browser.storage.local, "remove")
        .mockRejectedValue(new Error("storage unavailable"));

      await expect(resetFamilyEndpointChoice()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalled();
      // The background message is still sent, so the rest of the extension
      // reverts even when the local write could not.
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "SET_API_ENDPOINT",
        apiEndpoint: null,
      });

      removeSpy.mockRestore();
      warn.mockRestore();
    });
  });
});
