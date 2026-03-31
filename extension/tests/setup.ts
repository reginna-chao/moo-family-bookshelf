import "@testing-library/jest-dom/vitest";

// Mock chrome.runtime and chrome.storage for tests
const localStorageMock: Record<string, unknown> = {};
const syncStorageMock: Record<string, unknown> = {};

function createStorageAreaMock(store: Record<string, unknown>) {
  return {
    get: vi.fn((keys: string | string[], callback?: (result: Record<string, unknown>) => void) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of keyList) {
        if (key in store) result[key] = store[key];
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = {
  runtime: {
    id: "mock-extension-id",
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onInstalled: {
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
} as unknown as typeof chrome;
