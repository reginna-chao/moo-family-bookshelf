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
      isShared: BoolFlag.FALSE,
    })),
  ),
  asDecryptedBooks: vi.fn((books: unknown[]) => books),
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

  it("returns true when lastSyncAt is not set", async () => {
    setupStorage({});
    expect(await canAutoSync()).toBe(true);
  });

  it("returns true when lastSyncAt is more than 1 hour ago", async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    setupStorage({ lastSyncAt: twoHoursAgo });
    expect(await canAutoSync()).toBe(true);
  });

  it("returns false when lastSyncAt is less than 1 hour ago", async () => {
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    setupStorage({ lastSyncAt: thirtyMinutesAgo });
    expect(await canAutoSync()).toBe(false);
  });

  it("returns true when lastSyncAt is exactly 1 hour ago", async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    setupStorage({ lastSyncAt: oneHourAgo });
    expect(await canAutoSync()).toBe(true);
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

  it("returns error when encryptionKey is missing", async () => {
    setupStorage({ syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: false,
      userId: "user-123",
      apiClient,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("找不到加密金鑰");
  });

  it("returns error when upload fails", async () => {
    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
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

  it("handles decryption failure of saved books gracefully", async () => {
    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([
      {
        bookId: "b1",
        title: "New Book",
        author: "",
        coverUrl: "",
        readmooUrl: "https://readmoo.com/book/b1",
        category: "",
      },
    ]);

    // decrypt will throw because payload is not valid
    const { decrypt } = await import("@/crypto/encrypt");
    vi.mocked(decrypt).mockRejectedValueOnce(new Error("Decrypt failed"));

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({
        data: { payload: "invalid-encrypted-data" },
      }),
      updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: false,
      userId: "user-123",
      apiClient,
    });

    // Decrypt failure must abort sync to prevent overwriting server data (R1 invariant)
    expect(result.success).toBe(false);
    expect(result.decryptMismatch).toBe(true);
    expect(apiClient.updatePersonalBooks).not.toHaveBeenCalled();
  });

  it("navigates to #/library and restores hash when navigate=true", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { hash: "#/settings" },
    });

    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
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

  it("restores hash on error when navigate=true", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { hash: "#/me" },
    });

    setupStorage({ syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      updatePersonalBooks: vi.fn(),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: true,
      userId: "user-123",
      apiClient,
    });

    // Should fail (no encryption key) but hash should be restored
    expect(result.success).toBe(false);
    expect(window.location.hash).toBe("#/me");
  });

  it("updates lastSyncAt on success", async () => {
    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
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

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncAt: expect.any(Number) }),
    );
  });

  it("loads saved books from encrypted payload", async () => {
    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
    vi.mocked(scrapeBooks).mockResolvedValue([]);

    const { decrypt, importKey } = await import("@/crypto/encrypt");
    vi.mocked(importKey).mockResolvedValue({} as CryptoKey);
    vi.mocked(decrypt).mockResolvedValue(
      JSON.stringify({
        books: [
          { bookId: "saved-1", title: "Saved Book", isShared: BoolFlag.TRUE },
        ],
      }),
    );

    const apiClient: ApiClient = {
      getPersonalBooks: vi.fn().mockResolvedValue({
        data: { payload: "encrypted-data-string" },
      }),
      updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as unknown as ApiClient;

    const result = await syncBooks({
      navigate: false,
      userId: "user-123",
      apiClient,
    });

    expect(result.success).toBe(true);
    expect(decrypt).toHaveBeenCalledWith("encrypted-data-string", expect.anything());
  });

  it("loads saved books from plain books array", async () => {
    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
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

    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
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
    setupStorage({ encryptionKey: "test-key", displayName: "Test", syncArchived: 0 });
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
