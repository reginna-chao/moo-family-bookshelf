import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the background service worker message handlers.
 * Validates the sync+local dual-storage strategy.
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
        { familyId: "fam-abc" },
        expect.any(Function),
      );
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        { familyId: "fam-abc" },
        expect.any(Function),
      );
    });
  });

  describe("GET_FAMILY_ID", () => {
    it("returns familyId from sync storage when available", async () => {
      vi.mocked(chrome.storage.sync.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ familyId: "fam-from-sync" });
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
          callback({ familyId: "fam-from-local" });
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
        ["familyId"],
        expect.any(Function),
      );
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        ["familyId", "authToken", "tokenExpiresAt"],
        expect.any(Function),
      );
    });

    it("does not remove personalBooksCache", async () => {
      await sendMessage({ type: "CLEAR_FAMILY_ID" });

      // Verify that personalBooksCache is NOT in the keys removed from local storage
      const removeCalls = vi.mocked(chrome.storage.local.remove).mock.calls;
      for (const call of removeCalls) {
        const keys = call[0] as string[];
        expect(keys).not.toContain("personalBooksCache");
      }
    });
  });

  describe("GET_API_ENDPOINT", () => {
    it("reads apiEndpoint from local storage only", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ apiEndpoint: "https://custom.workers.dev" });
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
        { apiEndpoint: "https://custom.workers.dev" },
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
          callback({ familyShelfViewMode: "row" });
        },
      );
      const response = await sendMessage({ type: "GET_FAMILY_SHELF_VIEW_MODE" });
      expect(response).toEqual({ viewMode: "row" });
    });

    it("returns 'grid' when storage has invalid value", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ familyShelfViewMode: "foo" });
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
        { familyShelfViewMode: mode },
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
          callback({ floatingIconSize: size });
        },
      );
      const response = await sendMessage({ type: "GET_FLOATING_ICON_SIZE" });
      expect(response).toEqual({ size });
    });

    it("returns 'medium' when storage has invalid value", async () => {
      vi.mocked(chrome.storage.local.get).mockImplementation(
        (_keys: unknown, callback: (result: Record<string, unknown>) => void) => {
          callback({ floatingIconSize: "huge" });
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
        { floatingIconSize: size },
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
