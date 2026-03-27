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
    // @ts-expect-error — module has no exports, import is for side effects only
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
    it("removes familyId from sync and familyId+encryptionKey from local", async () => {
      const response = await sendMessage({ type: "CLEAR_FAMILY_ID" });

      expect(response).toEqual({ ok: true });
      expect(chrome.storage.sync.remove).toHaveBeenCalledWith(
        ["familyId"],
        expect.any(Function),
      );
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        ["familyId", "encryptionKey"],
        expect.any(Function),
      );
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

      expect(response).toEqual({ ok: true });
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        { apiEndpoint: "https://custom.workers.dev" },
        expect.any(Function),
      );
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });
  });
});
