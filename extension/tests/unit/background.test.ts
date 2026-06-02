import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  API_ENDPOINT_KEY,
  FAMILY_SHELF_VIEW_MODE_KEY,
  FLOATING_ICON_SIZE_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  FAMILY_SHELF_SORT_KEY,
  PERSONAL_SHELF_SORT_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
} from "@/constants";

// The background module runs migrateStorageKeys() at import time (and in
// onInstalled/onStartup). These handler tests are not about migration — it has
// its own suite in tests/unit/storage/migrate.test.ts — so stub it out to keep
// its storage side effects from polluting the chrome.storage spy assertions.
vi.mock("@/storage/migrate", () => ({
  migrateStorageKeys: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Tests for the background service worker message handlers.
 * Validates the sync+local dual-storage strategy.
 *
 * Note: message payloads (e.g. { type: "SET_FAMILY_ID", familyId }) and handler
 * response shapes (e.g. { familyId: value }) use their own field names and are
 * unrelated to storage keys. Only storage reads/writes use the `moo:`-prefixed
 * key constants.
 */

type MessageHandler = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

let handler: MessageHandler;

function sendMessage(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    handler(message, {} as chrome.runtime.MessageSender, (response) => {
      resolve(response as Record<string, unknown>);
    });
  });
}

describe("background service worker", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset storage mocks to empty state
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({});
      },
    );
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: unknown, callback?: () => void) => {
        callback?.();
        return Promise.resolve();
      },
    );
    vi.mocked(chrome.storage.local.remove).mockImplementation(
      (_keys: unknown, callback?: () => void) => {
        callback?.();
      },
    );
    vi.mocked(chrome.storage.sync.get).mockImplementation(
      (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
        callback({});
      },
    );
    vi.mocked(chrome.storage.sync.set).mockImplementation(
      (_items: unknown, callback?: () => void) => {
        callback?.();
        return Promise.resolve();
      },
    );
    vi.mocked(chrome.storage.sync.remove).mockImplementation(
      (_keys: unknown, callback?: () => void) => {
        callback?.();
      },
    );

    // Capture the onMessage listener registered by the module
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(
      (fn: MessageHandler) => {
        handler = fn;
      },
    );

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
      expect(chrome.storage.sync.set).toHaveBeenCalledWith(
        { [FAMILY_ID_KEY]: "fam-abc" },
        expect.any(Function),
      );
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        { [FAMILY_ID_KEY]: "fam-abc" },
        expect.any(Function),
      );
    });
  });

  describe("GET_FAMILY_ID", () => {
    it("returns familyId from sync storage when available", async () => {
      vi.mocked(chrome.storage.sync.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FAMILY_ID_KEY]: "fam-from-sync" });
        },
      );

      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: "fam-from-sync" });
      // Should NOT have queried local since sync had the value
      expect(chrome.storage.local.get).not.toHaveBeenCalled();
    });

    it("falls back to local storage when sync has no familyId", async () => {
      vi.mocked(chrome.storage.sync.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({});
        },
      );
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FAMILY_ID_KEY]: "fam-from-local" });
        },
      );

      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: "fam-from-local" });
    });

    it("returns null when neither sync nor local has familyId", async () => {
      const response = await sendMessage({ type: "GET_FAMILY_ID" });

      expect(response).toEqual({ familyId: null });
    });
  });

  describe("CLEAR_FAMILY_ID", () => {
    it("removes synced keys from sync and synced keys+authToken from local", async () => {
      const response = await sendMessage({ type: "CLEAR_FAMILY_ID" });

      expect(response).toEqual({ ok: true });
      expect(chrome.storage.sync.remove).toHaveBeenCalledWith(
        [FAMILY_ID_KEY],
        expect.any(Function),
      );
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        [FAMILY_ID_KEY, AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY],
        expect.any(Function),
      );
    });

    it("does not remove personalBooksCache", async () => {
      await sendMessage({ type: "CLEAR_FAMILY_ID" });

      // Verify that personalBooksCache is NOT in the keys removed from local storage
      const removeCalls = vi.mocked(chrome.storage.local.remove).mock.calls;
      for (const call of removeCalls) {
        const keys = call[0] as string[];
        expect(keys).not.toContain(PERSONAL_BOOKS_CACHE_KEY);
      }
    });
  });

  describe("GET_API_ENDPOINT", () => {
    it("reads apiEndpoint from local storage only", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [API_ENDPOINT_KEY]: "https://custom.workers.dev" });
        },
      );

      const response = await sendMessage({ type: "GET_API_ENDPOINT" });

      expect(response).toEqual({ apiEndpoint: "https://custom.workers.dev" });
      expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    });
  });

  describe("SET_API_ENDPOINT", () => {
    it("writes apiEndpoint to local storage only", async () => {
      const response = await sendMessage({
        type: "SET_API_ENDPOINT",
        apiEndpoint: "https://custom.workers.dev",
      });

      expect(response).toEqual({ ok: 1 });
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        { [API_ENDPOINT_KEY]: "https://custom.workers.dev" },
        expect.any(Function),
      );
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });
  });

  describe("GET_FAMILY_SHELF_VIEW_MODE", () => {
    it("returns 'grid' when storage has no value", async () => {
      const response = await sendMessage({ type: "GET_FAMILY_SHELF_VIEW_MODE" });
      expect(response).toEqual({ viewMode: "grid" });
    });

    it("returns 'row' when storage has 'row'", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FAMILY_SHELF_VIEW_MODE_KEY]: "row" });
        },
      );
      const response = await sendMessage({ type: "GET_FAMILY_SHELF_VIEW_MODE" });
      expect(response).toEqual({ viewMode: "row" });
    });

    it("returns 'grid' when storage has invalid value", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FAMILY_SHELF_VIEW_MODE_KEY]: "foo" });
        },
      );
      const response = await sendMessage({ type: "GET_FAMILY_SHELF_VIEW_MODE" });
      expect(response).toEqual({ viewMode: "grid" });
    });
  });

  describe("SET_FAMILY_SHELF_VIEW_MODE", () => {
    it.each(["grid", "row"] as const)("writes '%s' to local storage and responds ok", async (mode) => {
      const response = await sendMessage({
        type: "SET_FAMILY_SHELF_VIEW_MODE",
        viewMode: mode,
      });
      expect(response).toEqual({ ok: true });
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        { [FAMILY_SHELF_VIEW_MODE_KEY]: mode },
        expect.any(Function),
      );
    });

    it.each(["foo", undefined, 42, ""])(
      "rejects invalid value '%s' without writing",
      async (invalidValue) => {
        const response = await sendMessage({
          type: "SET_FAMILY_SHELF_VIEW_MODE",
          viewMode: invalidValue,
        });
        expect(response).toEqual({ ok: false, error: expect.any(String) });
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
      },
    );
  });

  describe("GET_FLOATING_ICON_SIZE", () => {
    it("returns 'medium' when storage has no value", async () => {
      const response = await sendMessage({ type: "GET_FLOATING_ICON_SIZE" });
      expect(response).toEqual({ size: "medium" });
    });

    it.each(["small", "medium", "large", "icon"] as const)("returns '%s' when storage has '%s'", async (size) => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FLOATING_ICON_SIZE_KEY]: size });
        },
      );
      const response = await sendMessage({ type: "GET_FLOATING_ICON_SIZE" });
      expect(response).toEqual({ size });
    });

    it("returns 'medium' when storage has invalid value", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FLOATING_ICON_SIZE_KEY]: "huge" });
        },
      );
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
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        { [FLOATING_ICON_SIZE_KEY]: size },
        expect.any(Function),
      );
    });

    it.each(["huge", undefined, 42, ""])(
      "rejects invalid value '%s' without writing",
      async (invalidValue) => {
        const response = await sendMessage({
          type: "SET_FLOATING_ICON_SIZE",
          size: invalidValue,
        });
        expect(response).toEqual({ ok: false, error: expect.any(String) });
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
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
        vi.mocked(chrome.storage.local.get).mockImplementation(
          (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
            callback({ [AUTO_SYNC_INTERVAL_KEY]: interval });
          },
        );
        const response = await sendMessage({ type: "GET_AUTO_SYNC_INTERVAL" });
        expect(response).toEqual({ interval });
      },
    );

    it("returns 'daily' when storage has invalid value", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [AUTO_SYNC_INTERVAL_KEY]: "yearly" });
        },
      );
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
        expect(chrome.storage.local.set).toHaveBeenCalledWith(
          { [AUTO_SYNC_INTERVAL_KEY]: interval },
          expect.any(Function),
        );
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
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
      },
    );
  });

  describe("GET_BOOK_SORT", () => {
    it("returns 'default' when storage has no value for family", async () => {
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "family" });
      expect(response).toEqual({ sort: "default" });
    });

    it("returns stored value for family shelf", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FAMILY_SHELF_SORT_KEY]: "title" });
        },
      );
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "family" });
      expect(response).toEqual({ sort: "title" });
    });

    it("returns stored value for personal shelf", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [PERSONAL_SHELF_SORT_KEY]: "author" });
        },
      );
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "personal" });
      expect(response).toEqual({ sort: "author" });
    });

    it("returns 'default' for invalid shelf", async () => {
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "invalid" });
      expect(response).toEqual({ sort: "default" });
    });

    it("returns 'default' when storage has invalid sort value", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ [FAMILY_SHELF_SORT_KEY]: "bogus" });
        },
      );
      const response = await sendMessage({ type: "GET_BOOK_SORT", shelf: "family" });
      expect(response).toEqual({ sort: "default" });
    });
  });

  describe("SET_BOOK_SORT", () => {
    it.each(
      (["default", "title", "author"] as const).flatMap((sort) =>
        (["family", "personal"] as const).map((shelf) => ({ sort, shelf })),
      ),
    )("writes '$sort' for '$shelf' to correct storage key", async ({ sort, shelf }) => {
      const response = await sendMessage({ type: "SET_BOOK_SORT", shelf, sort });
      expect(response).toEqual({ ok: true });
      const expectedKey = shelf === "family" ? FAMILY_SHELF_SORT_KEY : PERSONAL_SHELF_SORT_KEY;
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        { [expectedKey]: sort },
        expect.any(Function),
      );
    });

    it("rejects invalid shelf without writing", async () => {
      const response = await sendMessage({ type: "SET_BOOK_SORT", shelf: "invalid", sort: "title" });
      expect(response).toEqual({ ok: false, error: expect.any(String) });
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("rejects invalid sort without writing", async () => {
      const response = await sendMessage({ type: "SET_BOOK_SORT", shelf: "family", sort: "bogus" });
      expect(response).toEqual({ ok: false, error: expect.any(String) });
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
  });

  describe("sync error badge messages", () => {
    it("SET_SYNC_ERROR_BADGE sets badge text to '!'", async () => {
      await sendMessage({ type: "SET_SYNC_ERROR_BADGE" });

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
    });

    it("SET_SYNC_ERROR_BADGE sets red background color", async () => {
      await sendMessage({ type: "SET_SYNC_ERROR_BADGE" });

      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
        color: "#EF4444",
      });
    });

    it("SET_SYNC_ERROR_BADGE responds ok: true", async () => {
      const response = await sendMessage({ type: "SET_SYNC_ERROR_BADGE" });

      expect(response).toEqual({ ok: true });
    });

    it("CLEAR_SYNC_ERROR_BADGE sets badge text to empty string", async () => {
      await sendMessage({ type: "CLEAR_SYNC_ERROR_BADGE" });

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    });

    it("CLEAR_SYNC_ERROR_BADGE responds ok: true", async () => {
      const response = await sendMessage({ type: "CLEAR_SYNC_ERROR_BADGE" });

      expect(response).toEqual({ ok: true });
    });
  });
});
