import "@testing-library/jest-dom/vitest";

// Mock chrome.runtime and chrome.storage for tests
const localStorageMock: Record<string, unknown> = {};
const syncStorageMock: Record<string, unknown> = {};

function createStorageAreaMock(store: Record<string, unknown>) {
  return {
    get: vi.fn((keys: string[], callback: (result: Record<string, unknown>) => void) => {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in store) result[key] = store[key];
      }
      callback(result);
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
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
    },
    onInstalled: {
      addListener: vi.fn(),
    },
  },
  storage: {
    local: createStorageAreaMock(localStorageMock),
    sync: createStorageAreaMock(syncStorageMock),
  },
} as unknown as typeof chrome;
