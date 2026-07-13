import { describe, it, expect, vi, beforeEach } from "vitest";
import browser, { type Runtime } from "webextension-polyfill";
import {
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  API_ENDPOINT_KEY,
  FLOATING_ICON_SIZE_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  FAMILY_SHELF_SORT_KEY,
  PERSONAL_SHELF_SORT_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
} from "@/constants";

// The background module runs migrateStorageKeys() at import time (and in
// onInstalled/onStartup). These handler tests are not about migration — it has
// its own suite in tests/unit/storage/migrate.test.ts — so stub it out to keep
// its storage side effects from polluting the storage spy assertions.
vi.mock("@/storage/migrate", () => ({
  migrateStorageKeys: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Tests for the background service worker message handlers.
 * Validates the sync+local dual-storage strategy.
 *
 * Messaging contract (webextension-polyfill): the onMessage listener is an
 * async function that RETURNS a Promise resolving to the response object. There
 * is no Chrome `sendResponse` callback and no `return true`. These tests capture
 * the registered listener, invoke it with `(message, sender)`, and await the
 * returned Promise for the response.
 *
 * Storage contract: production uses promise-based `browser.storage.*` (get/set/
 * remove resolve a Promise). The mock spies are shared with `chrome.*` (see
 * tests/setup.ts); this file views them through the `browser.*` namespace so the
 * promise-native polyfill types line up with production. Storage writes take a
 * single argument (no trailing callback).
 *
 * Note: message payloads (e.g. { type: "SET_FAMILY_ID", familyId }) and handler
 * response shapes (e.g. { familyId: value }) use their own field names and are
 * unrelated to storage keys. Only storage reads/writes use the `moo:`-prefixed
 * key constants.
 */

type MessageListener = (
  message: Record<string, unknown>,
  sender: Runtime.MessageSender,
) => Promise<unknown> | undefined;

let listener: MessageListener;

function sendMessage(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return Promise.resolve(
    listener(message, {} as Runtime.MessageSender),
  ) as Promise<Record<string, unknown>>;
}

describe("background service worker", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset storage mocks to empty state (promise-based).
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    vi.mocked(browser.storage.local.set).mockResolvedValue();
    vi.mocked(browser.storage.local.remove).mockResolvedValue();
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    vi.mocked(browser.storage.sync.set).mockResolvedValue();
    vi.mocked(browser.storage.sync.remove).mockResolvedValue();

    // Capture the onMessage listener registered by the module. The polyfill's
    // addListener accepts the OnMessageListener union; our promise-returning
    // MessageListener is structurally the async variant. vitest's
    // mockImplementation wants the spy's own (normalized) signature, so cast the
    // capture fn to that exact parameter type rather than the raw polyfill type.
    const addListenerMock = vi.mocked(browser.runtime.onMessage.addListener);
    addListenerMock.mockImplementation(((fn: MessageListener) => {
      listener = fn;
    }) as Parameters<typeof addListenerMock.mockImplementation>[0]);

    // Side-effect import: registers onMessage listener
    await import("@/background/index");
  });

  describe("SET_FAMILY_ID", () => {
    it("writes familyId to both sync and local storage", async () => {
      const response = await sendMessage({
        type: "SET_FAMILY_ID",
        familyId: "fam-abc",
      });

      expect(response).toEqual({ ok: true });
      expect(browser.storage.sync.set).toHaveBeenCalledWith({
        [FAMILY_ID_KEY]: "fam-abc",
      });
      expect(browser.storage.local.set).toHaveBeenCalledWith({
        [FAMILY_ID_KEY]: "fam-abc",
      });
    });

    it("still writes familyId to local and resolves ok when sync.set rejects (Firefox)", async () => {
      vi.mocked(browser.storage.sync.set).mockRejectedValue(
        new Error("sync unavailable"),
      );

      const response = await sendMessage({
        type: "SET_FAMILY_ID",
        familyId: "fam-no-sync",
      });

      // Local-first ordering: the local write is independent of the sync
      // outcome, so it must persist even though sync threw.
      expect(browser.storage.local.set).toHaveBeenCalledWith({
        [FAMILY_ID_KEY]: "fam-no-sync",
      });
      // A sync rejection must not propagate; handler still resolves ok.
      expect(response).toEqual({ ok: true });
    });
  });

  describe("GET_FAMILY_ID", () => {
    it("returns familyId from sync storage when available", async () => {
      vi.mocked(browser.storage.sync.get).mockResolvedValue({
        [FAMILY_ID_KEY]: "fam-from-sync",
      });

      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: "fam-from-sync" });
      // Should NOT have queried local since sync had the value
      expect(browser.storage.local.get).not.toHaveBeenCalled();
    });

    it("falls back to local storage when sync has no familyId", async () => {
      vi.mocked(browser.storage.sync.get).mockResolvedValue({});
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [FAMILY_ID_KEY]: "fam-from-local",
      });

      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: "fam-from-local" });
    });

    it("returns null when neither sync nor local has familyId", async () => {
      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: null });
    });

    it("falls back to local and returns its value when sync.get rejects (Firefox)", async () => {
      vi.mocked(browser.storage.sync.get).mockRejectedValue(
        new Error("sync unavailable"),
      );
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [FAMILY_ID_KEY]: "fam-from-local",
      });

      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: "fam-from-local" });
    });

    it("returns null when sync.get rejects and local is also empty", async () => {
      vi.mocked(browser.storage.sync.get).mockRejectedValue(
        new Error("sync unavailable"),
      );

      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: null });
    });
  });

  describe("CLEAR_FAMILY_ID", () => {
    it("removes synced keys from sync and synced keys+authToken from local", async () => {
      const response = await sendMessage({ type: "CLEAR_FAMILY_ID" });

      expect(response).toEqual({ ok: true });
      expect(browser.storage.sync.remove).toHaveBeenCalledWith([FAMILY_ID_KEY]);
      expect(browser.storage.local.remove).toHaveBeenCalledWith([
        FAMILY_ID_KEY,
        AUTH_TOKEN_KEY,
        TOKEN_EXPIRES_AT_KEY,
      ]);
    });

    it("does not remove personalBooksCache", async () => {
      await sendMessage({ type: "CLEAR_FAMILY_ID" });

      // Verify that personalBooksCache is NOT in the keys removed from local storage
      const removeCalls = vi.mocked(browser.storage.local.remove).mock.calls;
      for (const call of removeCalls) {
        const keys = call[0] as string[];
        expect(keys).not.toContain(PERSONAL_BOOKS_CACHE_KEY);
      }
    });

    it("still removes local keys and resolves ok when sync.remove rejects (Firefox)", async () => {
      vi.mocked(browser.storage.sync.remove).mockRejectedValue(
        new Error("sync unavailable"),
      );

      const response = await sendMessage({ type: "CLEAR_FAMILY_ID" });

      // Local removal is authoritative and independent of the sync outcome, so
      // it must still run even though sync threw.
      expect(browser.storage.local.remove).toHaveBeenCalledWith([
        FAMILY_ID_KEY,
        AUTH_TOKEN_KEY,
        TOKEN_EXPIRES_AT_KEY,
      ]);
      // A sync rejection must not propagate; handler still resolves ok.
      expect(response).toEqual({ ok: true });
    });
  });

  describe("GET_API_ENDPOINT", () => {
    it("reads apiEndpoint from local storage only", async () => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [API_ENDPOINT_KEY]: "https://custom.workers.dev",
      });

      const response = await sendMessage({ type: "GET_API_ENDPOINT" });

      expect(response).toEqual({ apiEndpoint: "https://custom.workers.dev" });
      expect(browser.storage.sync.get).not.toHaveBeenCalled();
    });
  });

  describe("SET_API_ENDPOINT", () => {
    it("writes apiEndpoint to local storage only", async () => {
      const response = await sendMessage({
        type: "SET_API_ENDPOINT",
        apiEndpoint: "https://custom.workers.dev",
      });

      expect(response).toEqual({ ok: 1 });
      expect(browser.storage.local.set).toHaveBeenCalledWith({
        [API_ENDPOINT_KEY]: "https://custom.workers.dev",
      });
      expect(browser.storage.sync.set).not.toHaveBeenCalled();
    });
  });

  describe("GET_FLOATING_ICON_SIZE", () => {
    it("returns 'medium' when storage has no value", async () => {
      const response = await sendMessage({ type: "GET_FLOATING_ICON_SIZE" });
      expect(response).toEqual({ size: "medium" });
    });

    it.each(["small", "medium", "large", "icon"] as const)("returns '%s' when storage has '%s'", async (size) => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [FLOATING_ICON_SIZE_KEY]: size,
      });
      const response = await sendMessage({ type: "GET_FLOATING_ICON_SIZE" });
      expect(response).toEqual({ size });
    });

    it("returns 'medium' when storage has invalid value", async () => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [FLOATING_ICON_SIZE_KEY]: "huge",
      });
      const response = await sendMessage({ type: "GET_FLOATING_ICON_SIZE" });
      expect(response).toEqual({ size: "medium" });
    });
  });

  describe("SET_FLOATING_ICON_SIZE", () => {
    it.each(["small", "medium", "large", "icon"] as const)("writes '%s' to local storage and responds ok", async (size) => {
      const response = await sendMessage({
        type: "SET_FLOATING_ICON_SIZE",
        size,
      });
      expect(response).toEqual({ ok: true });
      expect(browser.storage.local.set).toHaveBeenCalledWith({
        [FLOATING_ICON_SIZE_KEY]: size,
      });
    });

    it.each(["huge", undefined, 42, ""])(
      "rejects invalid value '%s' without writing",
      async (invalidValue) => {
        const response = await sendMessage({
          type: "SET_FLOATING_ICON_SIZE",
          size: invalidValue,
        });
        expect(response).toEqual({ ok: false, error: expect.any(String) });
        expect(browser.storage.local.set).not.toHaveBeenCalled();
      },
    );
  });

  describe("GET_AUTO_SYNC_INTERVAL", () => {
    it("returns 'daily' when storage has no value", async () => {
      const response = await sendMessage({ type: "GET_AUTO_SYNC_INTERVAL" });
      expect(response).toEqual({ interval: "daily" });
    });

    it.each(["daily", "weekly", "monthly", "never"] as const)(
      "returns '%s' when storage has '%s'",
      async (interval) => {
        vi.mocked(browser.storage.local.get).mockResolvedValue({
          [AUTO_SYNC_INTERVAL_KEY]: interval,
        });
        const response = await sendMessage({ type: "GET_AUTO_SYNC_INTERVAL" });
        expect(response).toEqual({ interval });
      },
    );

    it("returns 'daily' when storage has invalid value", async () => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [AUTO_SYNC_INTERVAL_KEY]: "yearly",
      });
      const response = await sendMessage({ type: "GET_AUTO_SYNC_INTERVAL" });
      expect(response).toEqual({ interval: "daily" });
    });
  });

  describe("SET_AUTO_SYNC_INTERVAL", () => {
    it.each(["daily", "weekly", "monthly", "never"] as const)(
      "writes '%s' to local storage and responds ok",
      async (interval) => {
        const response = await sendMessage({
          type: "SET_AUTO_SYNC_INTERVAL",
          interval,
        });
        expect(response).toEqual({ ok: true });
        expect(browser.storage.local.set).toHaveBeenCalledWith({
          [AUTO_SYNC_INTERVAL_KEY]: interval,
        });
      },
    );

    it.each(["foo", undefined, 42, ""])(
      "rejects invalid value '%s' without writing",
      async (invalidValue) => {
        const response = await sendMessage({
          type: "SET_AUTO_SYNC_INTERVAL",
          interval: invalidValue,
        });
        expect(response).toEqual({ ok: false, error: expect.any(String) });
        expect(browser.storage.local.set).not.toHaveBeenCalled();
      },
    );
  });

  describe("GET_BOOK_SORT", () => {
    it("returns 'default' when storage has no value for family", async () => {
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "family" });
      expect(response).toEqual({ sort: "default" });
    });

    it("returns canonical stored value for family shelf", async () => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [FAMILY_SHELF_SORT_KEY]: "title-desc",
      });
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "family" });
      expect(response).toEqual({ sort: "title-desc" });
    });

    it("returns canonical stored value for personal shelf", async () => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [PERSONAL_SHELF_SORT_KEY]: "author-desc",
      });
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "personal" });
      expect(response).toEqual({ sort: "author-desc" });
    });

    it.each([
      { stored: "title", expected: "title-asc" },
      { stored: "author", expected: "author-asc" },
    ])(
      "normalizes legacy stored value '$stored' to '$expected'",
      async ({ stored, expected }) => {
        vi.mocked(browser.storage.local.get).mockResolvedValue({
          [FAMILY_SHELF_SORT_KEY]: stored,
        });
        const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "family" });
        expect(response).toEqual({ sort: expected });
      },
    );

    it("returns 'default' for invalid shelf", async () => {
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "invalid" });
      expect(response).toEqual({ sort: "default" });
    });

    it("returns 'default' when storage has invalid sort value", async () => {
      vi.mocked(browser.storage.local.get).mockResolvedValue({
        [FAMILY_SHELF_SORT_KEY]: "bogus",
      });
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "family" });
      expect(response).toEqual({ sort: "default" });
    });
  });

  describe("SET_BOOK_SORT", () => {
    it.each(
      (["default", "title-asc", "title-desc", "author-asc", "author-desc"] as const).flatMap(
        (sort) => (["family", "personal"] as const).map((shelf) => ({ sort, shelf })),
      ),
    )("writes canonical '$sort' for '$shelf' to correct storage key", async ({ sort, shelf }) => {
      const response = await sendMessage({ type: "SET_BOOK_SORT", shelf, sort });
      expect(response).toEqual({ ok: true });
      const expectedKey = shelf === "family" ? FAMILY_SHELF_SORT_KEY : PERSONAL_SHELF_SORT_KEY;
      expect(browser.storage.local.set).toHaveBeenCalledWith({
        [expectedKey]: sort,
      });
    });

    it.each([
      { legacy: "title", stored: "title-asc" },
      { legacy: "author", stored: "author-asc" },
    ])(
      "accepts legacy value '$legacy' and writes normalized '$stored'",
      async ({ legacy, stored }) => {
        const response = await sendMessage({ type: "SET_BOOK_SORT", shelf: "family", sort: legacy });
        expect(response).toEqual({ ok: true });
        expect(browser.storage.local.set).toHaveBeenCalledWith({
          [FAMILY_SHELF_SORT_KEY]: stored,
        });
      },
    );

    it("rejects invalid shelf without writing", async () => {
      const response = await sendMessage({
        type: "SET_BOOK_SORT",
        shelf: "invalid",
        sort: "title-asc",
      });
      expect(response).toEqual({ ok: false, error: expect.any(String) });
      expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    it.each(["bogus", "title-up", ""])(
      "rejects unrecognized sort value '%s' without writing",
      async (invalidSort) => {
        const response = await sendMessage({
          type: "SET_BOOK_SORT",
          shelf: "family",
          sort: invalidSort,
        });
        expect(response).toEqual({ ok: false, error: expect.any(String) });
        expect(browser.storage.local.set).not.toHaveBeenCalled();
      },
    );
  });

  describe("sync error badge messages", () => {
    it("SET_SYNC_ERROR_BADGE sets badge text to '!'", async () => {
      await sendMessage({ type: "SET_SYNC_ERROR_BADGE" });

      expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
    });

    it("SET_SYNC_ERROR_BADGE sets red background color", async () => {
      await sendMessage({ type: "SET_SYNC_ERROR_BADGE" });

      expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
        color: "#EF4444",
      });
    });

    it("SET_SYNC_ERROR_BADGE responds ok: true", async () => {
      const response = await sendMessage({ type: "SET_SYNC_ERROR_BADGE" });

      expect(response).toEqual({ ok: true });
    });

    it("CLEAR_SYNC_ERROR_BADGE sets badge text to empty string", async () => {
      await sendMessage({ type: "CLEAR_SYNC_ERROR_BADGE" });

      expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    });

    it("CLEAR_SYNC_ERROR_BADGE responds ok: true", async () => {
      const response = await sendMessage({ type: "CLEAR_SYNC_ERROR_BADGE" });

      expect(response).toEqual({ ok: true });
    });
  });
});
