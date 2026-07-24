import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// usePersonalBooks no longer scrapes on its own (the self-contained display
// scrape was removed). It loads cache-first: cache + API → reconciled baseline
// → "ready". Fresh books arrive later via `lastSyncBooks` (from useBookSync's
// auto full sync), merged by an effect. We still mock the scraper so any
// accidental call would be detectable, and assert it is never invoked.
vi.mock("@/content/scraper", () => ({
  scrapeBooks: vi.fn().mockResolvedValue([]),
  scrapeArchivedBooks: vi.fn().mockResolvedValue([]),
  formatScrapeProgress: (page: number, count: number) =>
    `正在讀取第 ${page} 頁，已收集 ${count} 本…`,
}));

import { usePersonalBooks } from "@/dialog/usePersonalBooks";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";
import { scrapeBooks } from "@/content/scraper";
import { PERSONAL_BOOKS_CACHE_KEY } from "@/constants";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    patchPersonalBooks: vi
      .fn()
      .mockResolvedValue({ data: { ok: true, applied: 0 } }),
    ...overrides,
  } as unknown as ApiClient;
}

/**
 * Configure chrome.storage.local.get so the load effect sees a controlled
 * cache + sync setting. `cache` (when provided) is the array stored under
 * PERSONAL_BOOKS_CACHE_KEY as a JSON string.
 */
function setupStorage(data: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...data };
  vi.mocked(chrome.storage.local.get).mockImplementation(
    (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of keyList) {
        if (typeof key === "string" && key in store) result[key] = store[key];
      }
      if (typeof callback === "function") {
        callback(result);
        return undefined as unknown as Promise<Record<string, unknown>>;
      }
      return Promise.resolve(result) as unknown as Promise<
        Record<string, unknown>
      >;
    },
  );
  vi.mocked(chrome.storage.local.set).mockImplementation(
    (_items: Record<string, unknown>) => Promise.resolve(),
  );
  return store;
}

function setCache(books: Partial<BookEntry>[]) {
  return { [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(books) };
}

function renderUsePersonalBooks(
  client?: ApiClient,
  lastSyncBooks: BookEntry[] = [],
) {
  // Create the client ONCE so the apiClient reference is stable across
  // re-renders — otherwise the load effect (deps: [userId, apiClient]) would
  // re-run on every state update and re-trigger the load.
  const apiClient = client ?? createMockApiClient();
  return renderHook(
    ({ lastSyncBooks: syncBooks }: { lastSyncBooks: BookEntry[] }) =>
      usePersonalBooks({
        userId: "user-abc",
        apiClient,
        lastSyncBooks: syncBooks,
        displayName: "小明",
      }),
    { initialProps: { lastSyncBooks } },
  );
}

async function waitForReady(result: { current: { status: string } }) {
  await waitFor(() => expect(result.current.status).toBe("ready"));
}

describe("usePersonalBooks — load flow (cache-first, no scrape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  it("never calls scrapeBooks during load (display scrape removed)", async () => {
    setupStorage(
      setCache([
        {
          bookId: "c1",
          title: "快取書一",
          author: "A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ]),
    );

    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    expect(scrapeBooks).not.toHaveBeenCalled();
  });

  it("shows books from cache when cache is present", async () => {
    setupStorage(
      setCache([
        {
          bookId: "c1",
          title: "快取書一",
          author: "A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.TRUE,
        },
      ]),
    );

    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].bookId).toBe("c1");
    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);
    expect(scrapeBooks).not.toHaveBeenCalled();
  });

  it("reconciles cache share flags against the server (API wins for known books)", async () => {
    // Cache says c1 is NOT shared; server says it IS shared → API wins.
    setupStorage(
      setCache([
        {
          bookId: "c1",
          title: "快取書一",
          author: "A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ]),
    );
    const client = createMockApiClient({
      getPersonalBooks: vi.fn().mockResolvedValue({
        data: {
          books: [
            {
              bookId: "c1",
              title: "快取書一",
              author: "A",
              isbn: "",
              coverUrl: "",
              readmooUrl: "",
              category: "",
              isShared: BoolFlag.TRUE,
            },
          ],
        },
      }),
    });

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("falls back to API books when cache absent but API has books", async () => {
    setupStorage(); // no cache
    const client = createMockApiClient({
      getPersonalBooks: vi.fn().mockResolvedValue({
        data: {
          books: [
            {
              bookId: "api-1",
              title: "API 書",
              author: "B",
              isbn: "",
              coverUrl: "",
              readmooUrl: "",
              category: "",
              isShared: BoolFlag.FALSE,
            },
          ],
        },
      }),
    });

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].bookId).toBe("api-1");
    expect(scrapeBooks).not.toHaveBeenCalled();
  });

  it("ends in empty ready state when neither cache nor API has books", async () => {
    setupStorage(); // no cache; API default returns data:null

    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    // Empty baseline must still resolve to ready (shows empty state, not stuck loading).
    expect(result.current.books).toHaveLength(0);
    expect(result.current.status).toBe("ready");
    expect(scrapeBooks).not.toHaveBeenCalled();
  });

  it("does not expose a progressMessage field (removed from the hook)", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    expect(result.current).not.toHaveProperty("progressMessage");
  });

  it("uses 'loading' (not 'scraping') as the pre-ready status", async () => {
    // Hold the API open so we can observe the pre-ready status.
    let resolveApi: (v: { data: null }) => void;
    const client = createMockApiClient({
      getPersonalBooks: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveApi = resolve;
        }),
      ),
    });

    const { result } = renderUsePersonalBooks(client);

    expect(result.current.status).toBe("loading");

    await act(async () => {
      resolveApi!({ data: null });
    });
    await waitForReady(result);
  });
});

describe("usePersonalBooks — lastSyncBooks merge effect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  it("merges newly synced books into the displayed list once ready", async () => {
    setupStorage(
      setCache([
        {
          bookId: "c1",
          title: "快取書一",
          author: "A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ]),
    );

    const { result, rerender } = renderUsePersonalBooks();
    await waitForReady(result);
    expect(result.current.books).toHaveLength(1);

    // Auto-sync streams a fresh book back via lastSyncBooks.
    act(() => {
      rerender({
        lastSyncBooks: [
          {
            bookId: "new-1",
            title: "新書",
            author: "C",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: BoolFlag.FALSE,
          },
        ],
      });
    });

    await waitFor(() => expect(result.current.books).toHaveLength(2));
    expect(result.current.books.map((b) => b.bookId)).toContain("new-1");
  });

  it("new synced books default to not-shared", async () => {
    setupStorage();
    const { result, rerender } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      rerender({
        lastSyncBooks: [
          {
            bookId: "new-1",
            title: "新書",
            author: "C",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: BoolFlag.FALSE,
          },
        ],
      });
    });

    await waitFor(() => expect(result.current.books).toHaveLength(1));
    expect(result.current.books[0].isShared).toBe(BoolFlag.FALSE);
  });

  it("does NOT overwrite an unsaved (dirty) toggle when sync books arrive (save-before-sync, invariant 3)", async () => {
    // Baseline: server-known book b1, currently NOT shared.
    setupStorage(
      setCache([
        {
          bookId: "b1",
          title: "書一",
          author: "A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ]),
    );

    const { result, rerender } = renderUsePersonalBooks();
    await waitForReady(result);

    // User toggles b1 to shared locally but has NOT saved yet → dirty.
    act(() => {
      result.current.handleToggle("b1");
    });
    expect(result.current.dirtyBookIds.has("b1")).toBe(true);
    expect(result.current.books.find((b) => b.bookId === "b1")?.isShared).toBe(
      BoolFlag.TRUE,
    );

    // Auto-sync completes and streams b1 back. mergeBooks merges scraped books
    // INTO the current (prev) list, keeping prev's isShared for known books, so
    // the user's unsaved toggle must survive — never reverted to the synced value.
    act(() => {
      rerender({
        lastSyncBooks: [
          {
            bookId: "b1",
            title: "書一（同步版）",
            author: "A",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: BoolFlag.FALSE,
          },
        ],
      });
    });

    await waitFor(() =>
      expect(result.current.books.find((b) => b.bookId === "b1")?.title).toBe(
        "書一（同步版）",
      ),
    );

    // Critical: the unsaved toggle is preserved (still TRUE), and b1 stays dirty.
    expect(result.current.books.find((b) => b.bookId === "b1")?.isShared).toBe(
      BoolFlag.TRUE,
    );
    expect(result.current.dirtyBookIds.has("b1")).toBe(true);
  });

  it("keeps synced-in new books after handleCancel, but reverts the unsaved toggle (S1 behaviour a)", async () => {
    // Baseline: server-known book b1, currently NOT shared.
    setupStorage(
      setCache([
        {
          bookId: "b1",
          title: "書一",
          author: "A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ]),
    );

    const { result, rerender } = renderUsePersonalBooks();
    await waitForReady(result);
    expect(result.current.books).toHaveLength(1);

    // Auto/manual sync streams a brand-new book b2 (absent from the baseline) →
    // the merge effect folds it into BOTH the display list and the cancel
    // baseline (originalBooks), so it must show up in books.
    act(() => {
      rerender({
        lastSyncBooks: [
          {
            bookId: "b2",
            title: "新書",
            author: "C",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: BoolFlag.FALSE,
          },
        ],
      });
    });
    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toContain("b2"),
    );

    // User toggles b1 to shared locally but does NOT save → dirty.
    act(() => {
      result.current.handleToggle("b1");
    });
    expect(result.current.dirtyBookIds.has("b1")).toBe(true);
    expect(result.current.books.find((b) => b.bookId === "b1")?.isShared).toBe(
      BoolFlag.TRUE,
    );

    // User presses "取消變更" → restores from the (merged) cancel baseline.
    act(() => {
      result.current.handleCancel();
    });

    // b2 (synced-in new book) must SURVIVE the cancel — it lives in the baseline.
    expect(result.current.books.map((b) => b.bookId)).toContain("b2");
    // b1's unsaved toggle must be reverted to its clean baseline value (FALSE).
    expect(result.current.books.find((b) => b.bookId === "b1")?.isShared).toBe(
      BoolFlag.FALSE,
    );
    // Dirty state fully cleared.
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });
});

describe("usePersonalBooks — dirty Set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Seed the baseline from cache (the hook is now cache-first, no scrape).
    // Handler tests toggle book-1 / book-2 against this 3-book set.
    setupStorage(
      setCache([
        {
          bookId: "book-1",
          title: "書一",
          author: "作者A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
        {
          bookId: "book-2",
          title: "書二",
          author: "作者B",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
        {
          bookId: "book-3",
          title: "書三",
          author: "作者C",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
      ]),
    );
  });

  it("starts with empty dirty set and isDirty=false", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it("handleToggle marks the toggled bookId as dirty", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
    });

    expect(result.current.dirtyBookIds.has("book-1")).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it("toggling the same book twice keeps it marked dirty (mark-only, no XOR)", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
    });
    act(() => {
      result.current.handleToggle("book-1");
    });

    expect(result.current.dirtyBookIds.has("book-1")).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it("markManyDirty adds multiple ids in one call", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.markManyDirty(["a", "b", "c"]);
    });

    expect(result.current.dirtyBookIds.size).toBe(3);
    expect(result.current.dirtyBookIds.has("a")).toBe(true);
    expect(result.current.dirtyBookIds.has("b")).toBe(true);
    expect(result.current.dirtyBookIds.has("c")).toBe(true);
  });

  it("markManyDirty does not duplicate existing ids", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.markManyDirty(["a"]);
    });
    act(() => {
      result.current.markManyDirty(["a", "b"]);
    });

    expect(result.current.dirtyBookIds.size).toBe(2);
    expect(result.current.dirtyBookIds.has("a")).toBe(true);
    expect(result.current.dirtyBookIds.has("b")).toBe(true);
  });

  it("markDirty returns same Set reference when bookId already present (no spurious re-render)", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.markDirty("book-1");
    });
    const firstRef = result.current.dirtyBookIds;

    act(() => {
      result.current.markDirty("book-1");
    });
    const secondRef = result.current.dirtyBookIds;

    expect(secondRef).toBe(firstRef);
  });

  it("handleSave clears the dirty set on success", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
      result.current.handleToggle("book-2");
    });
    expect(result.current.dirtyBookIds.size).toBe(2);

    // Fire handleSave; do NOT wrap in act(async), because the production code
    // schedules a 1500ms setTimeout for the "saved → ready" cleanup, and
    // act(async) waits for all pending React work to settle which would
    // hold us up for the timer. We instead poll the externally observable
    // state (dirtyBookIds cleared) via waitFor — that's the spec under test.
    void result.current.handleSave();

    await waitFor(() => {
      expect(result.current.dirtyBookIds.size).toBe(0);
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("handleSave keeps the dirty set when API returns error", async () => {
    const client = createMockApiClient({
      updatePersonalBooks: vi
        .fn()
        .mockResolvedValue({ error: { code: "BOOM", message: "failed" } }),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("book-1");
    });

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.dirtyBookIds.has("book-1")).toBe(true);
    expect(result.current.isDirty).toBe(true);
    expect(result.current.status).toBe("error");
  });

  it("handleCancel clears the dirty set and restores books", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    const originalSnapshot = result.current.books.map((b) => ({
      ...b,
      isShared: b.isShared,
    }));

    act(() => {
      result.current.handleToggle("book-1");
      result.current.handleToggle("book-2");
    });
    expect(result.current.dirtyBookIds.size).toBe(2);
    expect(
      result.current.books.find((b) => b.bookId === "book-1")?.isShared,
    ).toBe(BoolFlag.TRUE);

    act(() => {
      result.current.handleCancel();
    });

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(
      result.current.books.find((b) => b.bookId === "book-1")?.isShared,
    ).toBe(originalSnapshot[0].isShared);
  });
});

describe("usePersonalBooks — handleSave PATCH / PUT fallback", () => {
  const makeBook = (bookId: string, isShared = BoolFlag.FALSE): BookEntry => ({
    bookId,
    title: `書-${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared,
  });

  /** Build a client whose server record already contains `books` (server-known). */
  function clientWithServerBooks(
    books: BookEntry[],
    overrides: Partial<ApiClient> = {},
  ): ApiClient {
    return createMockApiClient({
      getPersonalBooks: vi.fn().mockResolvedValue({
        data: {
          schemaVersion: 1,
          userId: "user-abc",
          displayName: "小明",
          books,
          lastUpdated: "2026-01-01T00:00:00.000Z",
        },
      }),
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // No scrape; the baseline comes straight from the API record, so every book
    // is "server-known" unless a test injects a cache-only book.
    setupStorage();
  });

  it("PATCHes only the dirty book when all dirty books are server-known", async () => {
    const client = clientWithServerBooks([
      makeBook("b1"),
      makeBook("b2"),
      makeBook("b3"),
    ]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("b1");
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(client.patchPersonalBooks).toHaveBeenCalledWith("user-abc", [
      { bookId: "b1", isShared: BoolFlag.TRUE },
    ]);
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
  });

  it("PATCH changes array contains only dirty books (not untouched ones)", async () => {
    const client = clientWithServerBooks([
      makeBook("b1"),
      makeBook("b2"),
      makeBook("b3"),
    ]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("b1");
      result.current.handleToggle("b3");
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    const changes = vi.mocked(client.patchPersonalBooks).mock.calls[0][1];
    const ids = changes.map((c) => c.bookId).sort();
    expect(ids).toEqual(["b1", "b3"]);
    expect(ids).not.toContain("b2");
  });

  it("falls back to PUT when a dirty book is not yet on the server (new scraped book)", async () => {
    // Server knows only b1; cache carries a new un-synced book b2.
    setupStorage(setCache([makeBook("b1"), makeBook("b2")]));
    const client = clientWithServerBooks([makeBook("b1")]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // Toggle the new (server-unknown) book.
    act(() => {
      result.current.handleToggle("b2");
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(client.patchPersonalBooks).not.toHaveBeenCalled();
  });

  it("does not PATCH a new book after a prior PATCH save (no server-known contamination)", async () => {
    // Regression (review C1): a successful PATCH must NOT mark the full local
    // list as server-known. Otherwise a later save of an un-synced scraped book
    // would wrongly PATCH (backend silently drops unknown bookIds) instead of PUT.
    // Server knows only b1; cache carries a new un-synced book b2.
    setupStorage(setCache([makeBook("b1"), makeBook("b2")]));
    const client = clientWithServerBooks([makeBook("b1")]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // First save: toggle the server-known book b1 → PATCH.
    act(() => {
      result.current.handleToggle("b1");
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);

    // Second save: toggle the new (server-unknown) book b2 → must fall back to PUT.
    act(() => {
      result.current.handleToggle("b2");
    });
    await act(async () => {
      await result.current.handleSave();
    });

    // b2 must be persisted via PUT, and PATCH must NOT be called a second time.
    expect(client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    const putPayload = vi.mocked(client.updatePersonalBooks).mock.calls[0][1];
    expect(putPayload.books.some((b) => b.bookId === "b2")).toBe(true);
  });

  it("makes no API call when there are no dirty books", async () => {
    const client = clientWithServerBooks([makeBook("b1")]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
  });

  it("keeps dirty state and surfaces error when PATCH fails", async () => {
    const client = clientWithServerBooks([makeBook("b1")], {
      patchPersonalBooks: vi.fn().mockResolvedValue({
        error: { code: "BOOM", message: "patch failed" },
      }),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle("b1");
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("patch failed");
    expect(result.current.dirtyBookIds.has("b1")).toBe(true);
  });
});
