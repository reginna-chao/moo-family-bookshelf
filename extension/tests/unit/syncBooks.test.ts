import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scraper module
vi.mock("@/content/scraper", () => ({
  scrapeBooks: vi.fn().mockResolvedValue([]),
  scrapeArchivedBooks: vi.fn().mockResolvedValue([]),
}));

// Mock crypto module
vi.mock("@/crypto/encrypt", () => ({
  importKey: vi.fn().mockResolvedValue({} as CryptoKey),
  encrypt: vi.fn().mockResolvedValue("encrypted-payload"),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ books: [] })),
}));

// Mock mergeBooks — pass through by returning scraped as BookEntry[]
vi.mock("@/sync/mergeBooks", () => ({
  mergeBooks: vi.fn((scraped: unknown[]) =>
    (scraped as Record<string, unknown>[]).map((s) => ({
      ...s,
      isbn: "",
      isShared: false,
    })),
  ),
}));

import { syncBooks, type SyncBooksOptions } from "@/sync/syncBooks";
import { scrapeBooks, scrapeArchivedBooks } from "@/content/scraper";
import type { ApiClient } from "@/api/client";

function createMockApiClient(): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
  } as unknown as ApiClient;
}

function makeStorageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    encryptionKey: "test-enc-key",
    displayName: "Test User",
    syncArchived: 0,
    ...overrides,
  };
}

describe("syncBooks — archive sync path", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock window.location.hash
    Object.defineProperty(window, "location", {
      writable: true,
      value: { hash: "#/library" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupStorage(data: Record<string, unknown>) {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        // Return only requested keys
        const keyList = Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const key of keyList) {
          if (typeof key === "string" && key in data) {
            result[key] = data[key];
          }
        }
        if (typeof callback === "function") {
          callback(result);
          return undefined as unknown as Promise<Record<string, unknown>>;
        }
        return Promise.resolve(result) as unknown as Promise<Record<string, unknown>>;
      },
    );
    vi.mocked(chrome.storage.local.set).mockImplementation(
      (_items: Record<string, unknown>, _callback?: () => void) => {
        return Promise.resolve();
      },
    );
  }

  function makeOptions(overrides: Partial<SyncBooksOptions> = {}): SyncBooksOptions {
    return {
      navigate: false,
      userId: "user-123",
      apiClient: createMockApiClient(),
      ...overrides,
    };
  }

  it("does NOT call scrapeArchivedBooks when syncArchived=0", async () => {
    setupStorage(makeStorageData({ syncArchived: 0 }));
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    await syncBooks(makeOptions());

    expect(scrapeArchivedBooks).not.toHaveBeenCalled();
  });

  it("does NOT call scrapeArchivedBooks when syncArchived is absent", async () => {
    const data = makeStorageData();
    delete data.syncArchived;
    setupStorage(data);
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    await syncBooks(makeOptions());

    expect(scrapeArchivedBooks).not.toHaveBeenCalled();
  });

  it("calls scrapeArchivedBooks when syncArchived=1 and merges results", async () => {
    setupStorage(makeStorageData({ syncArchived: 1 }));

    const normalBooks = [
      {
        bookId: "book-1",
        title: "Normal Book",
        author: "Author A",
        coverUrl: "https://example.com/cover1.jpg",
        readmooUrl: "https://mooink.readmoo.com/book/book-1",
        isArchived: 0 as const,
      },
    ];
    const archivedBooks = [
      {
        bookId: "book-2",
        title: "Archived Book",
        author: "Author B",
        coverUrl: "https://example.com/cover2.jpg",
        readmooUrl: "https://mooink.readmoo.com/book/book-2",
        isArchived: 1 as const,
      },
    ];

    vi.mocked(scrapeBooks).mockResolvedValue(normalBooks);
    vi.mocked(scrapeArchivedBooks).mockResolvedValue(archivedBooks);

    const { mergeBooks } = await import("@/sync/mergeBooks");

    const result = await syncBooks(makeOptions());

    expect(scrapeArchivedBooks).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);

    // mergeBooks should have been called with the combined array
    expect(mergeBooks).toHaveBeenCalledWith(
      [...normalBooks, ...archivedBooks],
      expect.any(Array),
    );
  });

  it("calls updatePersonalBooks after merging archived books", async () => {
    setupStorage(makeStorageData({ syncArchived: 1 }));

    vi.mocked(scrapeBooks).mockResolvedValue([
      {
        bookId: "b1",
        title: "Book 1",
        author: "",
        coverUrl: "",
        readmooUrl: "https://mooink.readmoo.com/book/b1",
        isArchived: 0 as const,
      },
    ]);
    vi.mocked(scrapeArchivedBooks).mockResolvedValue([
      {
        bookId: "b2",
        title: "Archived Book",
        author: "",
        coverUrl: "",
        readmooUrl: "https://mooink.readmoo.com/book/b2",
        isArchived: 1 as const,
      },
    ]);

    const apiClient = createMockApiClient();
    const result = await syncBooks(makeOptions({ apiClient }));

    expect(result.success).toBe(true);
    // updatePersonalBooks should be called once with the userId
    expect(apiClient.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.updatePersonalBooks).mock.calls[0][0]).toBe("user-123");
  });
});
