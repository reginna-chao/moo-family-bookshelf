import "@testing-library/jest-dom/vitest";

// Mock chrome.runtime and chrome.storage for tests
const storageMock: Record<string, unknown> = {};

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
    local: {
      get: vi.fn((keys: string[], callback: (result: Record<string, unknown>) => void) => {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in storageMock) result[key] = storageMock[key];
        }
        callback(result);
      }),
      set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
        Object.assign(storageMock, items);
        callback?.();
      }),
      remove: vi.fn((key: string, callback?: () => void) => {
        delete storageMock[key];
        callback?.();
      }),
    },
  },
} as unknown as typeof chrome;
