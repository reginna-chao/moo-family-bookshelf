import "@testing-library/jest-dom/vitest";

/** WebExtension API mock: `globalThis.chrome` and `globalThis.browser` are ONE promise-style object that
 *  webextension-polyfill returns verbatim. See .claude/rules/test.md → Mock Policy. */

const localStorageMock: Record<string, unknown> = {};
const syncStorageMock: Record<string, unknown> = {};

function createStorageAreaMock(store: Record<string, unknown>) {
  return {
    get: vi.fn(
      (
        keys: string | string[] | null | undefined,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
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
      },
    ),
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
    getURL: vi.fn(
      (path: string) => `chrome-extension://mock-extension-id/${path}`,
    ),
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

/** jsdom lacks `window.matchMedia`: a desktop stub (every query `matches: false`) for useMediaQuery /
 *  useIsMobile. See .claude/rules/test.md → Mock Policy. */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = extensionApiMock as unknown as typeof chrome;
// A valid `runtime.id` makes the polyfill return `browser` verbatim (no re-wrap); same spies as `chrome`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).browser = extensionApiMock;
