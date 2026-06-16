import "@testing-library/jest-dom/vitest";

/**
 * Test environment mock for the WebExtension APIs.
 *
 * Production code was migrated (Wave #34) from the Chrome-only callback APIs
 * (`chrome.*`) to the promise-based `webextension-polyfill` (`browser.*`).
 * `import browser from "webextension-polyfill"` resolves as follows (see
 * node_modules/webextension-polyfill/dist/browser-polyfill.js):
 *
 *   - If `globalThis.browser` already exists AND has `runtime.id`, the polyfill
 *     returns that object verbatim (no wrapping).
 *   - Otherwise it wraps `globalThis.chrome`.
 *
 * We exploit the first branch: by defining `globalThis.browser` here with a
 * valid `runtime.id`, every `import browser from "webextension-polyfill"` in
 * production code resolves to OUR mock.
 *
 * To keep the ~290 existing `chrome.*` assertions working with zero churn,
 * `globalThis.chrome` and `globalThis.browser` are the SAME object: the spies
 * (`vi.fn()`) are shared, so a test that asserts on `chrome.storage.local.get`
 * observes the exact call production made via `browser.storage.local.get`.
 *
 * The mock is promise-style: `get`/`set`/`remove`/`clear` and `sendMessage`
 * return Promises. For back-compat with the few tests that still pass a Chrome
 * callback, the storage methods also invoke a trailing callback if provided.
 * `chrome.runtime.lastError` is retained for back-compat; the promise API never
 * consults it (errors are modeled as rejected promises instead).
 */

const localStorageMock: Record<string, unknown> = {};
const syncStorageMock: Record<string, unknown> = {};

function createStorageAreaMock(store: Record<string, unknown>) {
  return {
    get: vi.fn((keys: string | string[] | null | undefined, callback?: (result: Record<string, unknown>) => void) => {
      let result: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        // Match the real API: get(null) / get() returns the entire store.
        result = { ...store };
      } else {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) {
          if (key in store) result[key] = store[key];
        }
      }
      if (typeof callback === "function") {
        callback(result);
      }
      return Promise.resolve(result);
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(store, items);
      callback?.();
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[], callback?: () => void) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        delete store[key];
      }
      callback?.();
      return Promise.resolve();
    }),
    clear: vi.fn((callback?: () => void) => {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
      callback?.();
      return Promise.resolve();
    }),
  };
}

// Single shared mock surface, aliased as both `chrome` and `browser`.
const extensionApiMock = {
  runtime: {
    id: "mock-extension-id",
    getURL: vi.fn((path: string) => `chrome-extension://mock-extension-id/${path}`),
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onInstalled: {
      addListener: vi.fn(),
    },
    onStartup: {
      addListener: vi.fn(),
    },
    lastError: null,
  },
  storage: {
    local: createStorageAreaMock(localStorageMock),
    sync: createStorageAreaMock(syncStorageMock),
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  alarms: {
    create: vi.fn(),
    get: vi.fn().mockResolvedValue(undefined),
    onAlarm: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = extensionApiMock as unknown as typeof chrome;
// `browser` must carry a valid `runtime.id` so webextension-polyfill returns it
// verbatim instead of re-wrapping `chrome`. Shares the same spy objects as
// `chrome`, so assertions on either alias observe identical recorded calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).browser = extensionApiMock;
