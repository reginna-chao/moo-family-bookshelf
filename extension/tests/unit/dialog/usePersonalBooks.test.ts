import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { BOOKS_TOO_LARGE_MESSAGE } from "moo-family-bookshelf-shared/personal/saveErrors";

/**
 * Realistic 15-digit book ids. A real Readmoo id is 12+ digits (the scraper
 * refuses shorter ones), and the load path drops a CACHE-ONLY entry with a
 * short id as a stale legacy record — so fixtures that seed the cache must use
 * real-shaped ids or the entry vanishes before the test can observe it.
 */
const bookIdOf = (n: number): string => `21${String(n).padStart(13, "0")}`;
const C1 = bookIdOf(1);
const B1 = bookIdOf(2);
const B2 = bookIdOf(3);
const B3 = bookIdOf(4);
const BOOK_1 = bookIdOf(5);
const BOOK_2 = bookIdOf(6);
const BOOK_3 = bookIdOf(7);
const NEW_1 = bookIdOf(8);
const API_1 = bookIdOf(9);

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
  vi.mocked(chrome.storage.local.set).mockImplementation(() =>
    Promise.resolve(),
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

describe("usePersonalBooks — load flow (cache-first, no scrape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  it("never calls scrapeBooks during load (display scrape removed)", async () => {
    setupStorage(
      setCache([
        {
          bookId: C1,
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
          bookId: C1,
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
    expect(result.current.books[0].bookId).toBe(C1);
    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);
    expect(scrapeBooks).not.toHaveBeenCalled();
  });

  it("reconciles cache share flags against the server (API wins for known books)", async () => {
    // Cache says c1 is NOT shared; server says it IS shared → API wins.
    setupStorage(
      setCache([
        {
          bookId: C1,
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
              bookId: C1,
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
              bookId: API_1,
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
    expect(result.current.books[0].bookId).toBe(API_1);
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

// #234: short-id (7–8 digit) entries uploaded by early versions sit next to the
// real 15-digit entry for the same book. The baseline must not show both.
describe("usePersonalBooks — legacy short-id entries in the baseline", () => {
  const REAL_ID = "210180801000101";
  const LEGACY_ID = "14563038";
  const book = (bookId: string, isShared: BoolFlag): BookEntry => ({
    ...makeBook(bookId, isShared),
    title: "三體",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  it("drops a cache-only legacy duplicate the server no longer has", async () => {
    setupStorage(
      setCache([
        book(LEGACY_ID, BoolFlag.FALSE),
        book(REAL_ID, BoolFlag.FALSE),
      ]),
    );
    const client = clientWithServerBooks([book(REAL_ID, BoolFlag.TRUE)]);

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].bookId).toBe(REAL_ID);
    // API still wins on the share flag for the surviving real entry.
    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);
    expect(result.current.isDirty).toBe(false);
  });

  it("drops a server-side legacy duplicate when there is no cache", async () => {
    const client = clientWithServerBooks([
      book(LEGACY_ID, BoolFlag.TRUE),
      book(REAL_ID, BoolFlag.FALSE),
    ]);

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].bookId).toBe(REAL_ID);
    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("keeps a legacy entry that has no real-id twin", async () => {
    const client = clientWithServerBooks([
      book(LEGACY_ID, BoolFlag.TRUE),
      { ...makeBook(REAL_ID), title: "別本書" },
    ]);

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books.map((b) => b.bookId)).toEqual([
      LEGACY_ID,
      REAL_ID,
    ]);
  });

  it("never carries a stale cache-only legacy share flag onto the real twin (server FALSE wins)", async () => {
    // The cache still remembers the legacy entry as SHARED; the server only
    // knows the real entry, NOT shared. The cache-only legacy entry is stale,
    // so its flag must not resurrect sharing on the real book.
    setupStorage(
      setCache([book(LEGACY_ID, BoolFlag.TRUE), book(REAL_ID, BoolFlag.FALSE)]),
    );
    const client = clientWithServerBooks([book(REAL_ID, BoolFlag.FALSE)]);

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].bookId).toBe(REAL_ID);
    expect(result.current.books[0].isShared).toBe(BoolFlag.FALSE);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });

  it("saves via a PATCH that also unshares the server-side legacy entry after the real twin is unshared", async () => {
    // Server holds both copies; the legacy one is shared. The baseline folds it
    // into the real entry (carried flag), so the user sees one shared book.
    const client = clientWithServerBooks([
      book(LEGACY_ID, BoolFlag.TRUE),
      book(REAL_ID, BoolFlag.FALSE),
    ]);

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].bookId).toBe(REAL_ID);
    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);

    act(() => {
      result.current.handleToggle(REAL_ID);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    // Flipping R alone would leave the shared legacy copy on the server — the
    // book would stay shared. The PATCH carries an explicit unshare for L too.
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.patchPersonalBooks).mock.calls[0][1]).toEqual([
      { bookId: REAL_ID, isShared: BoolFlag.FALSE },
      { bookId: LEGACY_ID, isShared: BoolFlag.FALSE },
    ]);
  });

  it("sends the promoted twin's inherited share once, then folds it into the snapshot", async () => {
    const OTHER_ID = "210000000000003";
    const client = clientWithServerBooks([
      book(LEGACY_ID, BoolFlag.TRUE),
      book(REAL_ID, BoolFlag.FALSE),
      { ...makeBook(OTHER_ID), title: "別本書" },
    ]);

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // Baseline: R inherited L's share (promoted), nothing is dirty.
    expect(result.current.books.map((b) => [b.bookId, b.isShared])).toEqual([
      [REAL_ID, BoolFlag.TRUE],
      [OTHER_ID, BoolFlag.FALSE],
    ]);
    expect(result.current.isDirty).toBe(false);

    // First save touches only X, yet R's inherited share must reach the server.
    act(() => {
      result.current.handleToggle(OTHER_ID);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.patchPersonalBooks).mock.calls[0][1]).toEqual([
      { bookId: OTHER_ID, isShared: BoolFlag.TRUE },
      { bookId: REAL_ID, isShared: BoolFlag.TRUE },
      { bookId: LEGACY_ID, isShared: BoolFlag.FALSE },
    ]);

    // Second save: the first PATCH was folded into the snapshot — R is recorded
    // as shared and L's unshare as FALSE — so neither R nor L is re-sent.
    act(() => {
      result.current.handleToggle(OTHER_ID);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(2);
    const secondChanges = vi.mocked(client.patchPersonalBooks).mock.calls[1][1];
    expect(secondChanges).toEqual([
      { bookId: OTHER_ID, isShared: BoolFlag.FALSE },
    ]);
  });

  it("keeps an unsaved unshare when a shared legacy entry resolves mid-session via sync", async () => {
    // Different titles → L is unresolved at load, so the baseline shows both.
    const client = clientWithServerBooks([
      { ...makeBook(LEGACY_ID, BoolFlag.TRUE), title: "A" },
      { ...makeBook(REAL_ID, BoolFlag.TRUE), title: "B" },
    ]);

    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);
    expect(result.current.books.map((b) => [b.bookId, b.isShared])).toEqual([
      [LEGACY_ID, BoolFlag.TRUE],
      [REAL_ID, BoolFlag.TRUE],
    ]);

    // The user unshares R but has not saved yet.
    act(() => {
      result.current.handleToggle(REAL_ID);
    });
    expect(result.current.dirtyBookIds.has(REAL_ID)).toBe(true);

    // A sync renames R to "A", so L now resolves to R for the first time.
    act(() => {
      rerender({
        lastSyncBooks: [{ ...makeBook(REAL_ID), title: "A" }],
      });
    });
    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toEqual([REAL_ID]),
    );

    // Display: L dropped, R NOT re-shared by L's inherited flag.
    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].title).toBe("A");
    expect(result.current.books[0].isShared).toBe(BoolFlag.FALSE);
    expect(result.current.dirtyBookIds.has(REAL_ID)).toBe(true);
    // Cancel baseline holds no unsaved toggle, so promotion still applies there.
    expect(
      result.current.originalBooks.current.map((b) => [b.bookId, b.isShared]),
    ).toEqual([[REAL_ID, BoolFlag.TRUE]]);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    const changes = vi.mocked(client.patchPersonalBooks).mock.calls[0][1];
    expect(changes).toEqual([
      { bookId: REAL_ID, isShared: BoolFlag.FALSE },
      { bookId: LEGACY_ID, isShared: BoolFlag.FALSE },
    ]);
    expect(changes).not.toContainEqual({
      bookId: REAL_ID,
      isShared: BoolFlag.TRUE,
    });
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
          bookId: C1,
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
            bookId: NEW_1,
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
    expect(result.current.books.map((b) => b.bookId)).toContain(NEW_1);
  });

  it("new synced books default to not-shared", async () => {
    setupStorage();
    const { result, rerender } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      rerender({
        lastSyncBooks: [
          {
            bookId: NEW_1,
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
          bookId: B1,
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
      result.current.handleToggle(B1);
    });
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
    expect(result.current.books.find((b) => b.bookId === B1)?.isShared).toBe(
      BoolFlag.TRUE,
    );

    // Auto-sync completes and streams b1 back. mergeBooks merges scraped books
    // INTO the current (prev) list, keeping prev's isShared for known books, so
    // the user's unsaved toggle must survive — never reverted to the synced value.
    act(() => {
      rerender({
        lastSyncBooks: [
          {
            bookId: B1,
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
      expect(result.current.books.find((b) => b.bookId === B1)?.title).toBe(
        "書一（同步版）",
      ),
    );

    // Critical: the unsaved toggle is preserved (still TRUE), and b1 stays dirty.
    expect(result.current.books.find((b) => b.bookId === B1)?.isShared).toBe(
      BoolFlag.TRUE,
    );
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
  });

  it("keeps synced-in new books after handleCancel, but reverts the unsaved toggle (S1 behaviour a)", async () => {
    // Baseline: server-known book b1, currently NOT shared.
    setupStorage(
      setCache([
        {
          bookId: B1,
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
            bookId: B2,
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
      expect(result.current.books.map((b) => b.bookId)).toContain(B2),
    );

    // User toggles b1 to shared locally but does NOT save → dirty.
    act(() => {
      result.current.handleToggle(B1);
    });
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
    expect(result.current.books.find((b) => b.bookId === B1)?.isShared).toBe(
      BoolFlag.TRUE,
    );

    // User presses "取消變更" → restores from the (merged) cancel baseline.
    act(() => {
      result.current.handleCancel();
    });

    // b2 (synced-in new book) must SURVIVE the cancel — it lives in the baseline.
    expect(result.current.books.map((b) => b.bookId)).toContain(B2);
    // b1's unsaved toggle must be reverted to its clean baseline value (FALSE).
    expect(result.current.books.find((b) => b.bookId === B1)?.isShared).toBe(
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
          bookId: BOOK_1,
          title: "書一",
          author: "作者A",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
        {
          bookId: BOOK_2,
          title: "書二",
          author: "作者B",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: BoolFlag.FALSE,
        },
        {
          bookId: BOOK_3,
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
      result.current.handleToggle(BOOK_1);
    });

    expect(result.current.dirtyBookIds.has(BOOK_1)).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it("toggling the same book twice keeps it marked dirty (mark-only, no XOR)", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(BOOK_1);
    });
    act(() => {
      result.current.handleToggle(BOOK_1);
    });

    expect(result.current.dirtyBookIds.has(BOOK_1)).toBe(true);
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
      result.current.markDirty(BOOK_1);
    });
    const firstRef = result.current.dirtyBookIds;

    act(() => {
      result.current.markDirty(BOOK_1);
    });
    const secondRef = result.current.dirtyBookIds;

    expect(secondRef).toBe(firstRef);
  });

  it("handleSave clears the dirty set on success", async () => {
    const { result } = renderUsePersonalBooks();
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(BOOK_1);
      result.current.handleToggle(BOOK_2);
    });
    expect(result.current.dirtyBookIds.size).toBe(2);

    // Same barrier as every other handleSave site in this file. act(async)
    // flushes microtasks and pending effects; it never awaited the 1500ms
    // "saved → ready" setTimeout production schedules, so there is nothing to
    // be held up by — and that timer is now cleared on unmount as well
    // (src/dialog/usePersonalBooks.ts), so it cannot outlive the test either.
    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.dirtyBookIds.size).toBe(0);
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
      result.current.handleToggle(BOOK_1);
    });

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.dirtyBookIds.has(BOOK_1)).toBe(true);
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
      result.current.handleToggle(BOOK_1);
      result.current.handleToggle(BOOK_2);
    });
    expect(result.current.dirtyBookIds.size).toBe(2);
    expect(
      result.current.books.find((b) => b.bookId === BOOK_1)?.isShared,
    ).toBe(BoolFlag.TRUE);

    act(() => {
      result.current.handleCancel();
    });

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(
      result.current.books.find((b) => b.bookId === BOOK_1)?.isShared,
    ).toBe(originalSnapshot[0].isShared);
  });
});

describe("usePersonalBooks — handleSave PATCH / PUT fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No scrape; the baseline comes straight from the API record, so every book
    // is "server-known" unless a test injects a cache-only book.
    setupStorage();
  });

  it("PATCHes only the dirty book when all dirty books are server-known", async () => {
    const client = clientWithServerBooks([
      makeBook(B1),
      makeBook(B2),
      makeBook(B3),
    ]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(client.patchPersonalBooks).toHaveBeenCalledWith("user-abc", [
      { bookId: B1, isShared: BoolFlag.TRUE },
    ]);
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
  });

  it("PATCH changes array contains only dirty books (not untouched ones)", async () => {
    const client = clientWithServerBooks([
      makeBook(B1),
      makeBook(B2),
      makeBook(B3),
    ]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
      result.current.handleToggle(B3);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    const changes = vi.mocked(client.patchPersonalBooks).mock.calls[0][1];
    const ids = changes.map((c) => c.bookId).sort();
    expect(ids).toEqual([B1, B3]);
    expect(ids).not.toContain(B2);
  });

  it("falls back to PUT when a dirty book is not yet on the server (new scraped book)", async () => {
    // Server knows only b1; cache carries a new un-synced book b2.
    setupStorage(setCache([makeBook(B1), makeBook(B2)]));
    const client = clientWithServerBooks([makeBook(B1)]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // Toggle the new (server-unknown) book.
    act(() => {
      result.current.handleToggle(B2);
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
    setupStorage(setCache([makeBook(B1), makeBook(B2)]));
    const client = clientWithServerBooks([makeBook(B1)]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // First save: toggle the server-known book b1 → PATCH.
    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);

    // Second save: toggle the new (server-unknown) book b2 → must fall back to PUT.
    act(() => {
      result.current.handleToggle(B2);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    // b2 must be persisted via PUT, and PATCH must NOT be called a second time.
    expect(client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    const putPayload = vi.mocked(client.updatePersonalBooks).mock.calls[0][1];
    expect(putPayload.books.some((b) => b.bookId === B2)).toBe(true);
  });

  it("makes no API call when there are no dirty books", async () => {
    const client = clientWithServerBooks([makeBook(B1)]);
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
  });

  it("keeps dirty state and surfaces error when PATCH fails", async () => {
    const client = clientWithServerBooks([makeBook(B1)], {
      patchPersonalBooks: vi.fn().mockResolvedValue({
        error: { code: "BOOM", message: "patch failed" },
      }),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("patch failed");
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
  });
});

describe("usePersonalBooks — unmount cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the pending saved→ready timer on unmount", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { result, unmount } = renderUsePersonalBooks();
    await waitForReady(result);

    // A clean-state save takes the no-op branch: arms the timer, no network.
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.status).toBe("saved");

    // Ignore anything cleared before unmount (first arm clears no prior timer).
    clearSpy.mockClear();
    unmount();

    // Unmount cleanup must clear the armed reset timer, or the deferred
    // setStatus("ready") lands on an unmounted component.
    expect(clearSpy).toHaveBeenCalled();
  });
});

/**
 * A successful save leaves a 1500ms "saved → ready" reset armed. A SECOND save
 * started inside that window must supersede it: the old timer belongs to a
 * finished save, so letting it fire would rewrite the status of the one now in
 * flight — dropping the UI out of "saving" while the request is still on the
 * wire, or out of "error" after it came back failed.
 *
 * Timer discipline: settle the load with REAL timers first (`waitForReady` is a
 * waiter, and RTL cannot see vi's clock — it would poll a frozen one), and only
 * then install the fake clock. Past that point every assertion is synchronous;
 * a `waitFor` / `findBy*` here would hang to the full test timeout.
 */
describe("usePersonalBooks — stale reset-timer supersede", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps status 'saving' when the previous save's reset timer fires mid-flight", async () => {
    // b1 is server-known, so the second save goes out as a PATCH — and that
    // request never answers, holding the save in flight past the old deadline.
    const client = clientWithServerBooks([makeBook(B1)], {
      patchPersonalBooks: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    vi.useFakeTimers();

    // First save: nothing is dirty → the no-op branch arms the 1500ms reset
    // without spending a request. Same state a user is in right after any
    // successful save, minus the network.
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.status).toBe("saved");

    // Second save, still inside that window.
    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      void result.current.handleSave();
    });
    expect(result.current.status).toBe("saving");
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // The superseded timer must be dead. Otherwise the shelf goes back to
    // "ready" — re-enabling 儲存 — while the first request is still unanswered.
    expect(result.current.status).toBe("saving");
  });

  it("keeps the error state when the previous save's reset timer fires after a failure", async () => {
    const client = clientWithServerBooks([makeBook(B1)], {
      patchPersonalBooks: vi.fn().mockResolvedValue({
        error: { code: "BOOM", message: "patch failed" },
      }),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    vi.useFakeTimers();

    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.status).toBe("saved");

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("patch failed");

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // The stale reset must not swallow the failure: a silent return to "ready"
    // hides the banner while the toggle is still unsaved (dirty).
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("patch failed");
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
  });
});

/**
 * `patchPersonalBooks` / `updatePersonalBooks` resolve the `{ data, error }`
 * envelope through `readEnvelope`, which bare-casts `response.json()`
 * (src/api/client.ts), and the endpoint is user-configurable (BYO backend via
 * the sync code's `@host`), so `error.message` is `unknown` at runtime.
 * `errorMessage` is rendered as a JSX child by PersonalShelf; React 19 throws
 * on an object/array and the Dialog mounts no ErrorBoundary, so a refused save
 * used to blank the overlay instead of explaining itself.
 *
 * Both save strategies funnel through the SAME `response.error` branch, so one
 * case covers PATCH and PUT alike. The exhaustive value-domain proof lives in
 * tests/unit/safeErrorText.test.ts; this pins the wiring and the copy.
 */
describe("usePersonalBooks — hostile save error envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  it("falls back to the local save-failure copy for an object message", async () => {
    const client = clientWithServerBooks([makeBook(B1)], {
      patchPersonalBooks: vi.fn().mockResolvedValue({
        error: { code: "SERVER_ERROR", message: { zh: "壞掉了" } },
      }),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    // Literal from src/dialog/usePersonalBooks.ts (handleSave), read back off
    // the state the shelf renders. Exact equality proves the fallback REPLACED
    // the hostile value rather than sitting beside a leaked one.
    expect(result.current.errorMessage).toBe("儲存失敗，請稍後再試");
    expect(result.current.status).toBe("error");
    // A refused save keeps the toggle staged (save-before-sync, invariant 3).
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
  });
});

/**
 * A large shelf saved through PUT can exceed the Worker's body cap, which
 * answers `413 { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds …" }`.
 * The English byte-limit message must never reach the shelf; the shared
 * too-large copy replaces it. Both strategies share the one error branch, but
 * PUT is the realistic path (full list), so both are driven here.
 */
describe("usePersonalBooks — oversized save (413 PAYLOAD_TOO_LARGE)", () => {
  const TOO_LARGE = {
    error: {
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds 2MB limit",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the too-large copy when the PUT save is refused as too large", async () => {
    // Cache carries a book the server does not know yet → the save goes out as PUT.
    setupStorage(setCache([makeBook(B1), makeBook(B2)]));
    const client = clientWithServerBooks([makeBook(B1)], {
      updatePersonalBooks: vi.fn().mockResolvedValue(TOO_LARGE),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B2);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(result.current.errorMessage).toBe(BOOKS_TOO_LARGE_MESSAGE);
    expect(result.current.errorMessage).not.toContain("Request body exceeds");
    expect(result.current.status).toBe("error");
    // A refused save keeps the toggle staged (save-before-sync, invariant 3).
    expect(result.current.dirtyBookIds.has(B2)).toBe(true);
  });

  it("shows the too-large copy when the PATCH save is refused as too large", async () => {
    setupStorage();
    const client = clientWithServerBooks([makeBook(B1)], {
      patchPersonalBooks: vi.fn().mockResolvedValue(TOO_LARGE),
    });
    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(result.current.errorMessage).toBe(BOOKS_TOO_LARGE_MESSAGE);
    expect(result.current.status).toBe("error");
  });
});
