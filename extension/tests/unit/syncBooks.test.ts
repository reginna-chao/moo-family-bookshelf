import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scraper module
vi.mock("@/content/scraper", () => ({
  scrapeBooks: vi.fn().mockResolvedValue([]),
  scrapeArchivedBooks: vi.fn().mockResolvedValue([]),
}));

// Mock mergeBooks — pass through by returning scraped as BookEntry[]
vi.mock("@/sync/mergeBooks", () => ({
  mergeBooks: vi.fn((scraped: unknown[]) =>
    (scraped as Record<string, unknown>[]).map((s) => ({
      ...s,
      isbn: "",
      isShared: BoolFlag.FALSE,
    })),
  ),
}));

import { syncBooks, type SyncBooksOptions } from "@/sync/syncBooks";
import { scrapeBooks, scrapeArchivedBooks } from "@/content/scraper";
import { BoolFlag, type ApiClient } from "@/api/client";

function createMockApiClient(): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
  } as unknown as ApiClient;
}

function makeStorageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
        readmooUrl: "https://readmoo.com/book/book-1",
        category: "",
        isArchived: BoolFlag.FALSE,
      },
    ];
    const archivedBooks = [
      {
        bookId: "book-2",
        title: "Archived Book",
        author: "Author B",
        coverUrl: "https://example.com/cover2.jpg",
        readmooUrl: "https://readmoo.com/book/book-2",
        category: "",
        isArchived: BoolFlag.TRUE,
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
        readmooUrl: "https://readmoo.com/book/b1",
        category: "",
        isArchived: BoolFlag.FALSE,
      },
    ]);
    vi.mocked(scrapeArchivedBooks).mockResolvedValue([
      {
        bookId: "b2",
        title: "Archived Book",
        author: "",
        coverUrl: "",
        readmooUrl: "https://readmoo.com/book/b2",
        category: "",
        isArchived: BoolFlag.TRUE,
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

describe("canAutoSync", () => {
  let canAutoSync: () => Promise<boolean>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/sync/syncBooks");
    canAutoSync = mod.canAutoSync;
  });

  function setupStorage(data: Record<string, unknown>) {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
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
  }

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  describe("lastSyncAt not set", () => {
    it.each(["daily", "weekly", "monthly"] as const)(
      "returns true with interval '%s'",
      async (autoSyncInterval) => {
        setupStorage({ autoSyncInterval });
        expect(await canAutoSync()).toBe(true);
      },
    );

    it("returns true with default (no interval stored)", async () => {
      setupStorage({});
      expect(await canAutoSync()).toBe(true);
    });
  });

  describe("daily interval", () => {
    it("returns false when lastSyncAt is 1 hour ago", async () => {
      setupStorage({ autoSyncInterval: "daily", lastSyncAt: Date.now() - HOUR });
      expect(await canAutoSync()).toBe(false);
    });

    it("returns true when lastSyncAt is more than 24 hours ago", async () => {
      setupStorage({ autoSyncInterval: "daily", lastSyncAt: Date.now() - 2 * DAY });
      expect(await canAutoSync()).toBe(true);
    });

    it("returns true when lastSyncAt is exactly 24 hours ago", async () => {
      setupStorage({ autoSyncInterval: "daily", lastSyncAt: Date.now() - DAY });
      expect(await canAutoSync()).toBe(true);
    });
  });

  describe("weekly interval", () => {
    it("returns false when lastSyncAt is 3 days ago", async () => {
      setupStorage({ autoSyncInterval: "weekly", lastSyncAt: Date.now() - 3 * DAY });
      expect(await canAutoSync()).toBe(false);
    });

    it("returns true when lastSyncAt is more than 7 days ago", async () => {
      setupStorage({ autoSyncInterval: "weekly", lastSyncAt: Date.now() - 8 * DAY });
      expect(await canAutoSync()).toBe(true);
    });
  });

  describe("monthly interval", () => {
    it("returns false when lastSyncAt is 10 days ago", async () => {
      setupStorage({ autoSyncInterval: "monthly", lastSyncAt: Date.now() - 10 * DAY });
      expect(await canAutoSync()).toBe(false);
    });

    it("returns true when lastSyncAt is more than 30 days ago", async () => {
      setupStorage({ autoSyncInterval: "monthly", lastSyncAt: Date.now() - 31 * DAY });
      expect(await canAutoSync()).toBe(true);
    });
  });

  describe("never interval", () => {
    it("returns false even when lastSyncAt is very old", async () => {
      setupStorage({ autoSyncInterval: "never", lastSyncAt: Date.now() - 365 * DAY });
      expect(await canAutoSync()).toBe(false);
    });

    it("returns false when lastSyncAt is not set", async () => {
      setupStorage({ autoSyncInterval: "never" });
      expect(await canAutoSync()).toBe(false);
    });
  });

  describe("invalid/missing interval falls back to daily", () => {
    it("invalid value behaves like daily — false at 1 hour ago", async () => {
      setupStorage({ autoSyncInterval: "foo", lastSyncAt: Date.now() - HOUR });
      expect(await canAutoSync()).toBe(false);
    });

    it("invalid value behaves like daily — true at 25 hours ago", async () => {
      setupStorage({ autoSyncInterval: "foo", lastSyncAt: Date.now() - 25 * HOUR });
      expect(await canAutoSync()).toBe(true);
    });

    it("missing value behaves like daily — false at 1 hour ago", async () => {
      setupStorage({ lastSyncAt: Date.now() - HOUR });
      expect(await canAutoSync()).toBe(false);
    });

    it("missing value behaves like daily — true at 25 hours ago", async () => {
      setupStorage({ lastSyncAt: Date.now() - 25 * HOUR });
      expect(await canAutoSync()).toBe(true);
    });
  });
});

describe("canDisplayScrape", () => {
  let canDisplayScrape: () => Promise<boolean>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/sync/syncBooks");
    canDisplayScrape = mod.canDisplayScrape;
  });

  function setupStorage(data: Record<string, unknown>) {
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
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
  }

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  describe("lastDisplayScrapeAt not set", () => {
    it.each(["daily", "weekly", "monthly"] as const)(
      "returns true with interval '%s'",
      async (autoSyncInterval) => {
        setupStorage({ autoSyncInterval });
        expect(await canDisplayScrape()).toBe(true);
      },
    );

    it("returns true with default (no interval stored)", async () => {
      setupStorage({});
      expect(await canDisplayScrape()).toBe(true);
    });
  });

  describe("daily interval", () => {
    it("returns false when lastDisplayScrapeAt is 1 hour ago", async () => {
      setupStorage({ autoSyncInterval: "daily", lastDisplayScrapeAt: Date.now() - HOUR });
      expect(await canDisplayScrape()).toBe(false);
    });

    it("returns true when lastDisplayScrapeAt is more than 24 hours ago", async () => {
      setupStorage({ autoSyncInterval: "daily", lastDisplayScrapeAt: Date.now() - 2 * DAY });
      expect(await canDisplayScrape()).toBe(true);
    });

    it("returns true when lastDisplayScrapeAt is exactly 24 hours ago", async () => {
      setupStorage({ autoSyncInterval: "daily", lastDisplayScrapeAt: Date.now() - DAY });
      expect(await canDisplayScrape()).toBe(true);
    });
  });

  describe("weekly interval", () => {
    it("returns false when lastDisplayScrapeAt is 3 days ago", async () => {
      setupStorage({ autoSyncInterval: "weekly", lastDisplayScrapeAt: Date.now() - 3 * DAY });
      expect(await canDisplayScrape()).toBe(false);
    });

    it("returns true when lastDisplayScrapeAt is more than 7 days ago", async () => {
      setupStorage({ autoSyncInterval: "weekly", lastDisplayScrapeAt: Date.now() - 8 * DAY });
      expect(await canDisplayScrape()).toBe(true);
    });
  });

  describe("monthly interval", () => {
    it("returns false when lastDisplayScrapeAt is 10 days ago", async () => {
      setupStorage({ autoSyncInterval: "monthly", lastDisplayScrapeAt: Date.now() - 10 * DAY });
      expect(await canDisplayScrape()).toBe(false);
    });

    it("returns true when lastDisplayScrapeAt is more than 30 days ago", async () => {
      setupStorage({ autoSyncInterval: "monthly", lastDisplayScrapeAt: Date.now() - 31 * DAY });
      expect(await canDisplayScrape()).toBe(true);
    });
  });

  describe("never interval", () => {
    it("returns false even when lastDisplayScrapeAt is very old", async () => {
      setupStorage({ autoSyncInterval: "never", lastDisplayScrapeAt: Date.now() - 365 * DAY });
      expect(await canDisplayScrape()).toBe(false);
    });

    it("returns false when lastDisplayScrapeAt is not set", async () => {
      setupStorage({ autoSyncInterval: "never" });
      expect(await canDisplayScrape()).toBe(false);
    });
  });

  describe("invalid/missing interval falls back to daily", () => {
    it("invalid value behaves like daily — false at 1 hour ago", async () => {
      setupStorage({ autoSyncInterval: "foo", lastDisplayScrapeAt: Date.now() - HOUR });
      expect(await canDisplayScrape()).toBe(false);
    });

    it("invalid value behaves like daily — true at 25 hours ago", async () => {
      setupStorage({ autoSyncInterval: "foo", lastDisplayScrapeAt: Date.now() - 25 * HOUR });
      expect(await canDisplayScrape()).toBe(true);
    });

    it("missing value behaves like daily — false at 1 hour ago", async () => {
      setupStorage({ lastDisplayScrapeAt: Date.now() - HOUR });
      expect(await canDisplayScrape()).toBe(false);
    });

    it("missing value behaves like daily — true at 25 hours ago", async () => {
      setupStorage({ lastDisplayScrapeAt: Date.now() - 25 * HOUR });
      expect(await canDisplayScrape()).toBe(true);
    });
  });

  describe("independence from lastSyncAt", () => {
    it("ignores lastSyncAt — gate driven only by lastDisplayScrapeAt", async () => {
      // lastSyncAt is recent (would block canAutoSync) but lastDisplayScrapeAt
      // is absent → display scrape is still allowed.
      setupStorage({ autoSyncInterval: "daily", lastSyncAt: Date.now() - HOUR });
      expect(await canDisplayScrape()).toBe(true);
    });
  });
});

describe("syncBooks — full flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();

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

  it("returns error when upload fails", async () => {
    setupStorage({ displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      updatePersonalBooks: vi.fn().mockResolvedValue({
        error: { code: "UPLOAD_FAILED", message: "Upload error" },
      }),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: false,
      userId: "user-123",
      apiClient,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Upload error");
  });

  it("navigates to #/library and restores hash when navigate=true", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { hash: "#/settings" },
    });

    setupStorage({ displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: true,
      userId: "user-123",
      apiClient,
    });

    expect(result.success).toBe(true);
    // Hash should be restored to #/settings
    expect(window.location.hash).toBe("#/settings");
  });

  it("updates both lastSyncAt and lastDisplayScrapeAt on success", async () => {
    setupStorage({ displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as unknown as ApiClient;

    await syncBooks({
      navigate: false,
      userId: "user-123",
      apiClient,
    });

    // A full sync refreshes BOTH timers in a single set() so the display path
    // does not trigger a redundant re-scrape afterwards.
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSyncAt: expect.any(Number),
        lastDisplayScrapeAt: expect.any(Number),
      }),
    );
  });

  it("loads saved books from plain books array", async () => {
    setupStorage({ displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({
        data: {
          books: [{ bookId: "plain-1", title: "Plain Book" }],
        },
      }),
      updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as unknown as ApiClient;

    const { mergeBooks } = await import("@/sync/mergeBooks");

    const result = await syncBooks({
      navigate: false,
      userId: "user-123",
      apiClient,
    });

    expect(result.success).toBe(true);
    // mergeBooks should have been called with saved books from plain array
    expect(mergeBooks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.arrayContaining([expect.objectContaining({ bookId: "plain-1" })]),
    );
  });

  it("does not navigate when already on #/library", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { hash: "#/library" },
    });

    setupStorage({ displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: true,
      userId: "user-123",
      apiClient,
    });

    expect(result.success).toBe(true);
    // Hash should still be #/library (no navigation happened)
    expect(window.location.hash).toBe("#/library");
  });

  it("returns generic error message for non-Error exceptions", async () => {
    setupStorage({ displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockRejectedValue("string error");

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      updatePersonalBooks: vi.fn(),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: false,
      userId: "user-123",
      apiClient,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("同步失敗");
  });
});
