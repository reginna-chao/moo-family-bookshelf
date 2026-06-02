import { describe, it, expect, vi, beforeEach } from "vitest";
import { USER_ID_KEY, AUTH_TOKEN_KEY, API_ENDPOINT_KEY } from "@/constants";

/**
 * Tests for the content-script background-sync message handler
 * (`listenForBackgroundSync` in src/content/index.ts).
 *
 * Focus: the canAutoSync() skip gate. When auto-sync is disabled
 * (canAutoSync resolves false) the handler must NOT call syncBooks and
 * must respond `{ success: true, skipped: true }`, so the background
 * alarm handler does not raise an error badge.
 *
 * Dynamic-import interception:
 *   The handler loads the sync module via
 *     import(chrome.runtime.getURL("content-sync.js"))
 *   which (per tests/setup.ts) resolves to the literal specifier
 *     chrome-extension://mock-extension-id/content-sync.js
 *   We vi.mock that exact specifier so the dynamic import receives our
 *   stubbed { syncBooks, ApiClient, canAutoSync } without touching disk.
 */

// vi.mock is hoisted above all imports/consts, so its factory may only close
// over values created via vi.hoisted (also hoisted). Stubs live here.
const { syncBooks, canAutoSync, setAuthToken } = vi.hoisted(() => ({
  syncBooks: vi.fn(),
  canAutoSync: vi.fn(),
  setAuthToken: vi.fn(),
}));

vi.mock("chrome-extension://mock-extension-id/content-sync.js", () => {
  class MockApiClient {
    constructor(public readonly endpoint?: string) {}
    setAuthToken = setAuthToken;
  }
  return { syncBooks, canAutoSync, ApiClient: MockApiClient };
});

type MessageHandler = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

let handler: MessageHandler | undefined;

/**
 * Drive the captured onMessage handler and resolve with the response
 * passed to sendResponse. The handler is async (returns true), so we
 * resolve from the sendResponse callback rather than the return value.
 */
function trigger(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const captured = handler;
  if (!captured) throw new Error("onMessage listener was not registered");
  return new Promise((resolve) => {
    captured(message, {} as chrome.runtime.MessageSender, (response) => {
      resolve(response as Record<string, unknown>);
    });
  });
}

function mockStorage(values: Record<string, unknown>): void {
  vi.mocked(chrome.storage.local.get).mockImplementation(
    (() => Promise.resolve({ ...values })) as never,
  );
}

describe("listenForBackgroundSync — TRIGGER_BOOK_SYNC", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    handler = undefined;

    // chrome.runtime.id must be truthy for isExtensionContextValid().
    vi.mocked(chrome.runtime.getURL).mockImplementation(
      (path: string) => `chrome-extension://mock-extension-id/${path}`,
    );

    // Capture the listener registered at module import time. The content
    // script registers several listeners on import; we keep the one that
    // handles TRIGGER_BOOK_SYNC (it is the only message-typed handler).
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(
      ((fn: MessageHandler) => {
        handler = fn;
      }) as never,
    );

    mockStorage({ [USER_ID_KEY]: "user-1", [AUTH_TOKEN_KEY]: "tok-1", [API_ENDPOINT_KEY]: "https://api.test" });

    // Side-effect import: registers the onMessage listener.
    await import("@/content/index");
  });

  it("skips syncBooks and responds skipped:true when canAutoSync() is false", async () => {
    canAutoSync.mockResolvedValue(false);

    const response = await trigger({ type: "TRIGGER_BOOK_SYNC" });

    expect(canAutoSync).toHaveBeenCalledTimes(1);
    expect(syncBooks).not.toHaveBeenCalled();
    expect(response).toEqual({ success: true, skipped: true });
  });

  it("calls syncBooks when canAutoSync() is true and a userId exists", async () => {
    canAutoSync.mockResolvedValue(true);
    syncBooks.mockResolvedValue({ success: true });

    const response = await trigger({ type: "TRIGGER_BOOK_SYNC" });

    expect(canAutoSync).toHaveBeenCalledTimes(1);
    expect(syncBooks).toHaveBeenCalledTimes(1);
    expect(syncBooks).toHaveBeenCalledWith(
      expect.objectContaining({ navigate: true, userId: "user-1" }),
    );
    expect(response).toEqual({ success: true, error: undefined });
  });

  it("responds with No userId and never reaches the gate when userId is missing", async () => {
    mockStorage({ [AUTH_TOKEN_KEY]: "tok-1", [API_ENDPOINT_KEY]: "https://api.test" });

    const response = await trigger({ type: "TRIGGER_BOOK_SYNC" });

    expect(response).toEqual({ success: false, error: "No userId" });
    expect(canAutoSync).not.toHaveBeenCalled();
    expect(syncBooks).not.toHaveBeenCalled();
  });
});
