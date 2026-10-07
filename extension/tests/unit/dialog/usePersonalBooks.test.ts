import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * usePersonalBooks (`src/dialog/usePersonalBooks.ts`): load, toggle, save and
 * sync-result handling of the personal shelf.
 *
 * The hook no longer scrapes on its own (the self-contained display scrape was
 * removed). It loads the SERVER list only (#236: the local cache is never a
 * source of books) → "ready". Fresh books arrive later via `lastSyncBooks` (from
 * useBookSync's auto full sync), which REPLACES the list. The scraper is still
 * mocked so any accidental call would be detectable, and asserted never invoked.
 *
 * Fixtures: `bookIdOf` builds realistic 15-digit ids. A real Readmoo id is 12+
 * digits (the scraper refuses shorter ones), and the load path drops a
 * CACHE-ONLY entry with a short id as a stale legacy record — so fixtures that
 * seed the cache must use real-shaped ids or the entry vanishes before the test
 * can observe it. The render helper creates the API client ONCE so its reference
 * is stable across re-renders — otherwise the load effect (deps: [userId,
 * apiClient]) would re-run on every state update and re-trigger the load.
 *
 * #236 rewrites: several cases were rewritten when the cache stopped being a
 * source of books — a cached id the server no longer holds would be written
 * back by the next PUT. The cache-only "new scraped book" no longer exists:
 * every displayed book comes from the server or from a sync result the sync has
 * already uploaded, so the sync result IS the server-known set (formerly "falls
 * back to PUT when a dirty book is not yet on the server"); what remains of
 * "does not PATCH a new book after a prior PATCH save" is that a PATCH save
 * followed by a sync result leaves the snapshot equal to that result, so the
 * next save re-sends nothing already on the server.
 *
 * lastSyncBooks effect (#236): a successful sync result is exactly what the
 * server now holds, so it REPLACES the displayed list (it used to be merged into
 * `prev`, which kept a book whose Readmoo id changed on screen — and the next
 * PUT wrote the old id back). Unsaved toggles still win on display
 * (Invariant 3); the cancel baseline and the server snapshot become the sync
 * result. In the rename case the sync renames R to "A", so L resolves to R for
 * the first time; the result is what the server NOW holds — L dropped, R
 * carrying the server's (promoted, shared) flag, because the sync merged against
 * the server, which never saw the user's unsaved unshare.
 *
 * Save timers: `act(async)` flushes microtasks and pending effects; it never
 * awaited the 1500ms "saved → ready" setTimeout production schedules, and that
 * timer is cleared on unmount (src/dialog/useSavePersonalShelf.ts), so it cannot
 * outlive the test.
 *
 * Stale reset-timer supersede: a successful save leaves the 1500ms reset armed.
 * A SECOND save started inside that window must supersede it: the old timer
 * belongs to a finished save, so letting it fire would rewrite the status of the
 * one now in flight — dropping the UI out of "saving" (re-enabling 儲存) while
 * the request is still on the wire, or out of "error" after it came back
 * failed. The first save is the no-op branch (nothing dirty): it arms the reset
 * without spending a request — the state a user is in right after any
 * successful save, minus the network. Timer discipline: settle the load with
 * REAL timers first (`waitForReady` is a waiter, and RTL cannot see vi's clock —
 * it would poll a frozen one), and only then install the fake clock. Past that
 * point every assertion is synchronous; a `waitFor` / `findBy*` would hang to
 * the full test timeout.
 *
 * Hostile save error envelope: `patchPersonalBooks` / `updatePersonalBooks`
 * resolve the `{ data, error }` envelope through `readEnvelope`, which
 * bare-casts `response.json()` (src/api/client.ts), and the endpoint is
 * user-configurable (BYO backend via the sync code's `@host`), so
 * `error.message` is `unknown` at runtime. `errorMessage` is rendered as a JSX
 * child by PersonalShelf; React 19 throws on an object/array and the Dialog
 * mounts no ErrorBoundary, so a refused save used to blank the overlay instead
 * of explaining itself. Both save strategies funnel through the SAME
 * `response.error` branch, so one case covers PATCH and PUT alike. The
 * exhaustive value-domain proof lives in tests/unit/safeErrorText.test.ts; this
 * pins the wiring and the copy (literal from src/dialog/useSavePersonalShelf.ts,
 * asserted with exact equality so the fallback provably REPLACED the hostile
 * value rather than sitting beside a leaked one).
 *
 * Oversized save (413 PAYLOAD_TOO_LARGE): a large shelf saved through PUT can
 * exceed the Worker's body cap, which answers `413 { code: "PAYLOAD_TOO_LARGE",
 * message: "Request body exceeds …" }`. The English byte-limit message must
 * never reach the shelf; the shared too-large copy replaces it. Both strategies
 * share the one error branch, but PUT is the realistic path (full list), so
 * both are driven. Adapted for #236 (upstream seeded a server-unknown book
 * through the cache, which is no longer a source of books, and a book a sync
 * result brings in is server-known): the PUT is reached through the remaining
 * fallback — the user toggles B1, then a sync result drops it, and a dirty id
 * that left the list sends the displayed list whole.
 *
 * #236 fix cycle — a book whose Readmoo id changed: X (`OLD_X`) is its old id,
 * Y (`NEW_Y`) its new one. Both share one title, which is what the sync's
 * id-change resolution pairs on; the hook itself only sees the result
 * (`lastSyncBooks`) and the pairs (`lastSyncRenamedBooks`).
 *  - C1: a sync result applied while a save is in flight used to be overwritten
 *    by the save's success branch — the cancel baseline, server snapshot and
 *    cache went back to the PRE-sync list, so Cancel resurrected the replaced X,
 *    the cache held X, and the next save unshared Y. `startSave` returns the
 *    in-flight promise wrapped: an async function returning it bare would adopt
 *    it and wait for the save.
 *  - S1: an unsaved toggle on a book whose Readmoo id the sync replaced follows
 *    the book to its new id — and stays unsaved: the sync uploads nothing of it
 *    (save-before-sync, Invariant 3).
 *
 * #250: a share change made while a save is in flight used to lose its unsaved
 * mark when that save succeeded — the success path cleared the WHOLE dirty set,
 * so the screen showed the new flag with nothing to save while the server held
 * the sent one. Only the ids the save really saved may be cleared now. Each case
 * holds the save's PATCH open with `heldPatch()`, edits mid-flight, then
 * releases it. The 1500ms saved→ready timer is cleared by RTL's unmount.
 */

// The hook must never scrape (#236); mocked only so an accidental call is
// detectable. See the file header.
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
import type { RenamedBook } from "@/sync/renamedBooks";

/** Realistic 15-digit book ids — a short cache-only id is dropped on load.
 *  See the header → "Fixtures". */
const bookIdOf = (n: number): string => `21${String(n).padStart(13, "0")}`;
const C1 = bookIdOf(1);
const B1 = bookIdOf(2);
const B2 = bookIdOf(3);
const B3 = bookIdOf(4);
const BOOK_1 = bookIdOf(5);
const BOOK_2 = bookIdOf(6);
const BOOK_3 = bookIdOf(7);
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

/** Make chrome.storage.local.get serve a controlled cache + sync setting; `cache` is
 *  stored under PERSONAL_BOOKS_CACHE_KEY as a JSON string. */
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

interface HookProps {
  lastSyncBooks: BookEntry[];
  /** Omitted ⇒ the hook's own default (no renames). */
  lastSyncRenamedBooks?: RenamedBook[];
}

function renderUsePersonalBooks(
  client?: ApiClient,
  lastSyncBooks: BookEntry[] = [],
) {
  // Create the client ONCE: a new reference would re-run the load effect
  // (deps: [userId, apiClient]) on every state update.
  const apiClient = client ?? createMockApiClient();
  return renderHook(
    ({ lastSyncBooks: syncBooks, lastSyncRenamedBooks }: HookProps) =>
      usePersonalBooks({
        userId: "user-abc",
        apiClient,
        lastSyncBooks: syncBooks,
        lastSyncRenamedBooks,
        displayName: "小明",
      }),
    { initialProps: { lastSyncBooks } as HookProps },
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

describe("usePersonalBooks — load flow (server list only, no scrape)", () => {
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

  // Rewritten for #236 (was "shows books from cache when cache is present"); see
  // the header → "#236 rewrites".
  it("never shows a cache-only book — the list is the server's", async () => {
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
    const client = clientWithServerBooks([makeBook(API_1)]);

    const { result } = renderUsePersonalBooks(client);
    await waitForReady(result);

    expect(result.current.books.map((b) => b.bookId)).toEqual([API_1]);
    // The cache is not even read at load.
    const readKeys = vi
      .mocked(chrome.storage.local.get)
      .mock.calls.flatMap(([keys]) => (Array.isArray(keys) ? keys : [keys]));
    expect(readKeys).not.toContain(PERSONAL_BOOKS_CACHE_KEY);
    expect(scrapeBooks).not.toHaveBeenCalled();
  });

  it("shows an empty shelf, not the cache, when the server has no record", async () => {
    setupStorage(setCache([makeBook(C1, BoolFlag.TRUE)]));

    const { result } = renderUsePersonalBooks(); // getPersonalBooks → data: null

    await waitForReady(result);
    expect(result.current.books).toEqual([]);
  });

  it("enters the error state with the server's message when the read fails", async () => {
    setupStorage(setCache([makeBook(C1)]));
    const client = createMockApiClient({
      getPersonalBooks: vi.fn().mockResolvedValue({
        error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" },
      }),
    });

    const { result } = renderUsePersonalBooks(client);

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toBe("伺服器忙碌");
    expect(result.current.books).toEqual([]);
  });

  it("falls back to the local load-failure copy for a hostile read-error message", async () => {
    const client = createMockApiClient({
      getPersonalBooks: vi.fn().mockResolvedValue({
        error: { code: "INTERNAL_ERROR", message: { zh: "壞掉了" } },
      }),
    });

    const { result } = renderUsePersonalBooks(client);

    await waitFor(() => expect(result.current.status).toBe("error"));
    // Literal from src/dialog/usePersonalBooks.ts (the load error branch).
    expect(result.current.errorMessage).toBe("載入失敗");
  });

  it("shows the server's share flag whatever the cache says", async () => {
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
    // The stale cache-only legacy entry is SHARED, the server's real entry is
    // not: the stale flag must not resurrect sharing.
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

    // The sync result (L dropped, R shared) REPLACES the list since #236 — it
    // used to be MERGED. See the header → "lastSyncBooks effect".
    act(() => {
      rerender({
        lastSyncBooks: [{ ...makeBook(REAL_ID, BoolFlag.TRUE), title: "A" }],
      });
    });
    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toEqual([REAL_ID]),
    );

    // Display: L gone, and the server's shared flag does NOT override the
    // user's unsaved unshare (Invariant 3).
    expect(result.current.books).toHaveLength(1);
    expect(result.current.books[0].title).toBe("A");
    expect(result.current.books[0].isShared).toBe(BoolFlag.FALSE);
    expect(result.current.dirtyBookIds.has(REAL_ID)).toBe(true);
    // Cancel baseline = the sync result (no unsaved toggle in it).
    expect(
      result.current.originalBooks.current.map((b) => [b.bookId, b.isShared]),
    ).toEqual([[REAL_ID, BoolFlag.TRUE]]);

    await act(async () => {
      await result.current.handleSave();
    });

    // The server no longer holds L (the sync's upload dropped it), so only R's
    // unshare goes out — and it is an unshare, never a re-share.
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    const changes = vi.mocked(client.patchPersonalBooks).mock.calls[0][1];
    expect(changes).toEqual([{ bookId: REAL_ID, isShared: BoolFlag.FALSE }]);
    expect(changes).not.toContainEqual({
      bookId: REAL_ID,
      isShared: BoolFlag.TRUE,
    });
  });
});

// #236: a sync result REPLACES the list; unsaved toggles still win on display.
// See the header → "lastSyncBooks effect".
describe("usePersonalBooks — lastSyncBooks effect", () => {
  const OLD = B1;
  const KEEP = B2;
  const NEW = B3;

  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  /** Server holds OLD (shared) + KEEP; the sync replaced OLD by NEW. */
  function renamedServer() {
    return clientWithServerBooks([
      makeBook(OLD, BoolFlag.TRUE),
      makeBook(KEEP),
    ]);
  }
  const SYNC_RESULT = [makeBook(KEEP), makeBook(NEW, BoolFlag.TRUE)];

  // Rewritten (was "merges newly synced books into the displayed list").
  it("replaces the displayed list with the sync result", async () => {
    const { result, rerender } = renderUsePersonalBooks(renamedServer());
    await waitForReady(result);

    act(() => {
      rerender({ lastSyncBooks: SYNC_RESULT });
    });

    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toEqual([KEEP, NEW]),
    );
    expect(result.current.books.map((b) => b.bookId)).not.toContain(OLD);
    expect(result.current.originalBooks.current.map((b) => b.bookId)).toEqual([
      KEEP,
      NEW,
    ]);
  });

  // Rewritten (was "new synced books default to not-shared", which only echoed
  // a fixture flag): the sync result carries the server's flags.
  it("shows the sync result's share flags for books with no unsaved toggle", async () => {
    const client = clientWithServerBooks([makeBook(B1, BoolFlag.FALSE)]);
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      rerender({ lastSyncBooks: [makeBook(B1, BoolFlag.TRUE)] });
    });

    await waitFor(() =>
      expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE),
    );
    expect(result.current.isDirty).toBe(false);
  });

  it("does not write a pruned book back with a PUT save", async () => {
    const client = renamedServer();
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // The user unshares OLD before the sync lands → OLD is dirty.
    act(() => {
      result.current.handleToggle(OLD);
    });
    act(() => {
      rerender({ lastSyncBooks: SYNC_RESULT });
    });
    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toEqual([KEEP, NEW]),
    );

    // A dirty id that left the list forces a full PUT of the displayed list.
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    const put = vi.mocked(client.updatePersonalBooks).mock.calls[0][1];
    expect(put.books.map((b) => b.bookId)).toEqual([KEEP, NEW]);
  });

  it("does not send a pruned book in a PATCH save either", async () => {
    const client = renamedServer();
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      rerender({ lastSyncBooks: SYNC_RESULT });
    });
    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toEqual([KEEP, NEW]),
    );

    act(() => {
      result.current.handleToggle(KEEP);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    // The sync result is the server snapshot now: NEW is server-known (PATCH,
    // not PUT), and OLD is neither re-sent nor "unshared".
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(vi.mocked(client.patchPersonalBooks).mock.calls[0][1]).toEqual([
      { bookId: KEEP, isShared: BoolFlag.TRUE },
    ]);
  });

  it("keeps an unsaved toggle on display when a sync result arrives (save-before-sync, invariant 3)", async () => {
    const client = clientWithServerBooks([{ ...makeBook(B1), title: "書一" }]);
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // User toggles b1 to shared locally but has NOT saved yet → dirty.
    act(() => {
      result.current.handleToggle(B1);
    });
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);

    // The sync result still carries the server's FALSE (and fresh metadata).
    act(() => {
      rerender({
        lastSyncBooks: [{ ...makeBook(B1), title: "書一（同步版）" }],
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
    // The cancel baseline holds no unsaved toggle.
    expect(result.current.originalBooks.current[0].isShared).toBe(
      BoolFlag.FALSE,
    );
  });

  it("keeps synced-in new books after handleCancel, but reverts the unsaved toggle (S1 behaviour a)", async () => {
    const client = clientWithServerBooks([makeBook(B1)]);
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // The sync brings a brand-new book b2 → it becomes part of the baseline.
    act(() => {
      rerender({ lastSyncBooks: [makeBook(B1), makeBook(B2)] });
    });
    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toContain(B2),
    );

    act(() => {
      result.current.handleToggle(B1);
    });
    expect(result.current.books.find((b) => b.bookId === B1)?.isShared).toBe(
      BoolFlag.TRUE,
    );

    act(() => {
      result.current.handleCancel();
    });

    expect(result.current.books.map((b) => b.bookId)).toEqual([B1, B2]);
    expect(result.current.books.find((b) => b.bookId === B1)?.isShared).toBe(
      BoolFlag.FALSE,
    );
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });

  it("applies a sync result only once — a later save is not undone by it", async () => {
    const client = clientWithServerBooks([makeBook(B1)]);
    const syncResult = [makeBook(B1, BoolFlag.FALSE)];
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      rerender({ lastSyncBooks: syncResult });
    });

    // Share b1 and save: the status walks saving → saved, re-running the
    // effect with the SAME (now stale) sync result.
    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.status).toBe("saved");
    // Same result re-delivered on a re-render (same reference).
    act(() => {
      rerender({ lastSyncBooks: syncResult });
    });

    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);
    expect(result.current.originalBooks.current[0].isShared).toBe(
      BoolFlag.TRUE,
    );
  });

  it("applies a sync result that arrives while a save is in flight", async () => {
    const client = clientWithServerBooks([makeBook(B1)], {
      patchPersonalBooks: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      void result.current.handleSave();
    });
    expect(result.current.status).toBe("saving");

    act(() => {
      rerender({ lastSyncBooks: [makeBook(B1), makeBook(B2)] });
    });

    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toEqual([B1, B2]),
    );
    // The in-flight toggle is still dirty → still shown as shared.
    expect(result.current.books[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("ignores an empty sync result", async () => {
    const client = clientWithServerBooks([makeBook(B1)]);
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      rerender({ lastSyncBooks: [] });
    });

    expect(result.current.books.map((b) => b.bookId)).toEqual([B1]);
  });
});

describe("usePersonalBooks — dirty Set", () => {
  // The baseline comes from the server record (#236: no longer the cache).
  // Handler tests toggle book-1 / book-2 against this 3-book set.
  function threeBookClient(overrides: Partial<ApiClient> = {}): ApiClient {
    return clientWithServerBooks(
      [
        { ...makeBook(BOOK_1), title: "書一", author: "作者A" },
        { ...makeBook(BOOK_2), title: "書二", author: "作者B" },
        { ...makeBook(BOOK_3), title: "書三", author: "作者C" },
      ],
      overrides,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  it("starts with empty dirty set and isDirty=false", async () => {
    const { result } = renderUsePersonalBooks(threeBookClient());
    await waitForReady(result);

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it("handleToggle marks the toggled bookId as dirty", async () => {
    const { result } = renderUsePersonalBooks(threeBookClient());
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(BOOK_1);
    });

    expect(result.current.dirtyBookIds.has(BOOK_1)).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it("toggling the same book twice keeps it marked dirty (mark-only, no XOR)", async () => {
    const { result } = renderUsePersonalBooks(threeBookClient());
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
    const { result } = renderUsePersonalBooks(threeBookClient());
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
    const { result } = renderUsePersonalBooks(threeBookClient());
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
    const { result } = renderUsePersonalBooks(threeBookClient());
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
    const { result } = renderUsePersonalBooks(threeBookClient());
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(BOOK_1);
      result.current.handleToggle(BOOK_2);
    });
    expect(result.current.dirtyBookIds.size).toBe(2);

    // Same barrier as every other handleSave site; it never awaits the 1500ms
    // reset timer. See the header → "Save timers".
    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it("handleSave keeps the dirty set when API returns error", async () => {
    // Server-known books save via PATCH, so that is where the failure goes.
    const client = threeBookClient({
      patchPersonalBooks: vi
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
    const { result } = renderUsePersonalBooks(threeBookClient());
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

  // Rewritten for #236: the sync result IS the server-known set. See the header
  // → "#236 rewrites".
  it("PATCHes a book that a sync result just added (the sync already uploaded it)", async () => {
    const client = clientWithServerBooks([makeBook(B1)]);
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      rerender({ lastSyncBooks: [makeBook(B1), makeBook(B2)] });
    });
    await waitFor(() =>
      expect(result.current.books.map((b) => b.bookId)).toEqual([B1, B2]),
    );

    act(() => {
      result.current.handleToggle(B2);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledWith("user-abc", [
      { bookId: B2, isShared: BoolFlag.TRUE },
    ]);
  });

  it("saves by PATCH after the first sync result when the server had no record at load", async () => {
    // getPersonalBooks → data: null: the shelf starts empty, and the first
    // sync's upload creates the record — its result is the server snapshot.
    const client = createMockApiClient();
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);
    expect(result.current.books).toEqual([]);

    act(() => {
      rerender({ lastSyncBooks: [makeBook(B1)] });
    });
    await waitFor(() => expect(result.current.books).toHaveLength(1));
    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
  });

  // Rewritten for #236: PATCH save + sync result leaves the snapshot equal to the
  // result. See the header → "#236 rewrites".
  it("re-sends nothing the server already holds after a PATCH save and a sync", async () => {
    const client = clientWithServerBooks([makeBook(B1)]);
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);

    act(() => {
      rerender({
        lastSyncBooks: [makeBook(B1, BoolFlag.TRUE), makeBook(B2)],
      });
    });
    await waitFor(() => expect(result.current.books).toHaveLength(2));

    act(() => {
      result.current.handleToggle(B2);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.patchPersonalBooks).mock.calls[1][1]).toEqual([
      { bookId: B2, isShared: BoolFlag.TRUE },
    ]);
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

// A second save inside the 1500ms window supersedes the old reset timer; real
// timers until ready, then fake. See the header → "Stale reset-timer supersede".
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

    // First save: nothing dirty → the no-op branch arms the 1500ms reset without
    // a request (a just-saved user's state, minus the network).
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

// A hostile `error.message` must not blank the overlay; one case covers PATCH and
// PUT. See the header → "Hostile save error envelope".
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

    // Literal from src/dialog/useSavePersonalShelf.ts; exact equality proves the
    // fallback REPLACED the hostile value.
    expect(result.current.errorMessage).toBe("儲存失敗，請稍後再試");
    expect(result.current.status).toBe("error");
    // A refused save keeps the toggle staged (save-before-sync, invariant 3).
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
  });
});

// The Worker's English 413 message never reaches the shelf; the shared too-large
// copy replaces it. See the header → "Oversized save".
describe("usePersonalBooks — oversized save (413 PAYLOAD_TOO_LARGE)", () => {
  const TOO_LARGE = {
    error: {
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds 2MB limit",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  it("shows the too-large copy when the PUT save is refused as too large", async () => {
    // Adapted for #236: PUT via the remaining fallback — toggle B1, then a sync
    // result drops it. See the header → "Oversized save".
    const client = clientWithServerBooks([makeBook(B1, BoolFlag.TRUE)], {
      updatePersonalBooks: vi.fn().mockResolvedValue(TOO_LARGE),
    });
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(B1);
    });
    await act(async () => {
      rerender({ lastSyncBooks: [makeBook(B2)] });
    });
    expect(result.current.books.map((b) => b.bookId)).toEqual([B2]);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(result.current.errorMessage).toBe(BOOKS_TOO_LARGE_MESSAGE);
    expect(result.current.errorMessage).not.toContain("Request body exceeds");
    expect(result.current.status).toBe("error");
    // A refused save keeps the toggle staged (save-before-sync, invariant 3).
    expect(result.current.dirtyBookIds.has(B1)).toBe(true);
  });

  it("shows the too-large copy when the PATCH save is refused as too large", async () => {
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

// #236 fix cycle: X is the old Readmoo id, Y the new one, one shared title.
// See the header → "#236 fix cycle".
const OLD_X = bookIdOf(20);
const NEW_Y = bookIdOf(21);
const OTHER_A = bookIdOf(22);
const OTHER_K = bookIdOf(23);
const X_TO_Y: RenamedBook[] = [{ oldId: OLD_X, newId: NEW_Y }];

const renamedBook = (bookId: string, isShared: BoolFlag): BookEntry => ({
  ...makeBook(bookId, isShared),
  title: "改了編號的書",
});

function flagsOf(
  books: readonly BookEntry[] | undefined,
): Array<[string, BoolFlag]> {
  return (books ?? []).map((b) => [b.bookId, b.isShared]);
}

/** The books of the LAST personal-books cache write, parsed. */
function lastCachedBooks(): BookEntry[] | undefined {
  const writes = vi
    .mocked(chrome.storage.local.set)
    .mock.calls.map(([items]) => items as Record<string, unknown>)
    .filter((items) => items !== null && PERSONAL_BOOKS_CACHE_KEY in items);
  const last = writes.at(-1);
  return last === undefined
    ? undefined
    : (
        JSON.parse(last[PERSONAL_BOOKS_CACHE_KEY] as string) as {
          books: BookEntry[];
        }
      ).books;
}

/** A PATCH whose FIRST call stays pending until `release()`; later calls succeed. */
function heldPatch() {
  let resolveFirst: ((value: unknown) => void) | undefined;
  const patch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValue({ data: { ok: true, applied: 1 } });
  return {
    patch,
    release: () => resolveFirst?.({ data: { ok: true, applied: 1 } }),
  };
}

// C1: the save's success branch must not overwrite a sync result applied
// mid-flight. See the header → "#236 fix cycle".
describe("usePersonalBooks — a sync result that lands while a save is in flight (#236)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  const SYNC_X_TO_Y = [
    renamedBook(NEW_Y, BoolFlag.TRUE),
    makeBook(OTHER_A),
    makeBook(OTHER_K),
  ];

  /** Start a save and leave it in flight; the promise is returned wrapped, since a
   *  bare return would adopt it and wait for the save. */
  async function startSave(result: {
    current: { handleSave: () => Promise<void>; status: string };
  }): Promise<{ pending: Promise<void> }> {
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.handleSave();
    });
    expect(result.current.status).toBe("saving");
    return { pending };
  }

  it("never brings the replaced id back on Cancel, in the cache, or in the next save", async () => {
    const { patch, release } = heldPatch();
    const client = clientWithServerBooks(
      [renamedBook(OLD_X, BoolFlag.TRUE), makeBook(OTHER_A), makeBook(OTHER_K)],
      { patchPersonalBooks: patch },
    );
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    act(() => {
      result.current.handleToggle(OTHER_A);
    });
    const { pending } = await startSave(result);
    expect(patch.mock.calls[0][1]).toEqual([
      { bookId: OTHER_A, isShared: BoolFlag.TRUE },
    ]);

    // The sync result lands mid-save: X replaced by Y.
    await act(async () => {
      rerender({ lastSyncBooks: SYNC_X_TO_Y, lastSyncRenamedBooks: X_TO_Y });
    });
    expect(result.current.books.map((b) => b.bookId)).toEqual([
      NEW_Y,
      OTHER_A,
      OTHER_K,
    ]);

    vi.mocked(chrome.storage.local.set).mockClear();
    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.status).toBe("saved");
    expect(result.current.isDirty).toBe(false);

    // The sync result with the saved flag folded in.
    const rebased: Array<[string, BoolFlag]> = [
      [NEW_Y, BoolFlag.TRUE],
      [OTHER_A, BoolFlag.TRUE],
      [OTHER_K, BoolFlag.FALSE],
    ];
    expect(flagsOf(result.current.originalBooks.current)).toEqual(rebased);
    expect(flagsOf(lastCachedBooks())).toEqual(rebased);

    // Toggle another book, then Cancel: X must not come back.
    act(() => {
      result.current.handleToggle(OTHER_K);
    });
    act(() => {
      result.current.handleCancel();
    });
    expect(flagsOf(result.current.books)).toEqual(rebased);
    expect(result.current.books.map((b) => b.bookId)).not.toContain(OLD_X);

    // The next save sends just its own toggle: no unshare of Y, no stale PUT.
    act(() => {
      result.current.handleToggle(OTHER_K);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: OTHER_K, isShared: BoolFlag.TRUE },
    ]);
    expect(patch.mock.calls[1][1]).not.toContainEqual({
      bookId: NEW_Y,
      isShared: BoolFlag.FALSE,
    });
  });

  it("keeps an id that became dirty mid-save dirty once the save resolves", async () => {
    const { patch, release } = heldPatch();
    const client = clientWithServerBooks(
      [renamedBook(OLD_X, BoolFlag.TRUE), makeBook(OTHER_A), makeBook(OTHER_K)],
      { patchPersonalBooks: patch },
    );
    const { result, rerender } = renderUsePersonalBooks(client);
    await waitForReady(result);

    // Unshare X and share A, then save: both go out in the PATCH.
    act(() => {
      result.current.handleToggle(OLD_X);
      result.current.handleToggle(OTHER_A);
    });
    const { pending } = await startSave(result);
    expect(patch.mock.calls[0][1]).toEqual([
      { bookId: OLD_X, isShared: BoolFlag.FALSE },
      { bookId: OTHER_A, isShared: BoolFlag.TRUE },
    ]);

    // Mid-save the sync moves X to Y (shared on the server): X's unsaved
    // unshare follows to Y, which was NOT part of the save in flight.
    await act(async () => {
      rerender({ lastSyncBooks: SYNC_X_TO_Y, lastSyncRenamedBooks: X_TO_Y });
    });
    expect([...result.current.dirtyBookIds].sort()).toEqual(
      [NEW_Y, OTHER_A].sort(),
    );

    await act(async () => {
      release();
      await pending;
    });

    // Only the ids the save carried are cleared; Y's unshare is still staged.
    expect([...result.current.dirtyBookIds]).toEqual([NEW_Y]);
    expect(result.current.isDirty).toBe(true);
    expect(result.current.books.find((b) => b.bookId === NEW_Y)?.isShared).toBe(
      BoolFlag.FALSE,
    );
    expect(
      result.current.originalBooks.current.find((b) => b.bookId === NEW_Y)
        ?.isShared,
    ).toBe(BoolFlag.TRUE);

    await act(async () => {
      await result.current.handleSave();
    });
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: NEW_Y, isShared: BoolFlag.FALSE },
    ]);
  });
});

// S1: an unsaved toggle follows a renamed book to its new id and stays unsaved
// (save-before-sync, Invariant 3).
describe("usePersonalBooks — an unsaved toggle follows a renamed book (#236)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  const SERVER = [renamedBook(OLD_X, BoolFlag.TRUE), makeBook(OTHER_K)];
  /** The sync replaced X by Y, which inherited X's server-side share. */
  const SYNC_X_TO_Y = [renamedBook(NEW_Y, BoolFlag.TRUE), makeBook(OTHER_K)];

  async function unshareXThenSync(lastSyncRenamedBooks?: RenamedBook[]) {
    const client = clientWithServerBooks(SERVER);
    const hook = renderUsePersonalBooks(client);
    await waitForReady(hook.result);
    act(() => {
      hook.result.current.handleToggle(OLD_X);
    });
    await act(async () => {
      hook.rerender({ lastSyncBooks: SYNC_X_TO_Y, lastSyncRenamedBooks });
    });
    return { client, ...hook };
  }

  it("shows the new id with the unsaved flag and saves it as one PATCH change", async () => {
    const { client, result } = await unshareXThenSync(X_TO_Y);

    expect(flagsOf(result.current.books)).toEqual([
      [NEW_Y, BoolFlag.FALSE],
      [OTHER_K, BoolFlag.FALSE],
    ]);
    expect([...result.current.dirtyBookIds]).toEqual([NEW_Y]);
    // The sync applied nothing to the server on the user's behalf.
    expect(client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    // The cancel baseline is the pure sync result.
    expect(flagsOf(result.current.originalBooks.current)).toEqual([
      [NEW_Y, BoolFlag.TRUE],
      [OTHER_K, BoolFlag.FALSE],
    ]);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.patchPersonalBooks).mock.calls[0][1]).toEqual([
      { bookId: NEW_Y, isShared: BoolFlag.FALSE },
    ]);
  });

  it("restores the new id's server flag on Cancel", async () => {
    const { result } = await unshareXThenSync(X_TO_Y);

    act(() => {
      result.current.handleCancel();
    });

    expect(flagsOf(result.current.books)).toEqual([
      [NEW_Y, BoolFlag.TRUE],
      [OTHER_K, BoolFlag.FALSE],
    ]);
    expect(result.current.isDirty).toBe(false);
  });

  it("drops the toggle with the old id when no rename pairs are passed (as before)", async () => {
    const { result } = await unshareXThenSync(undefined);

    expect(flagsOf(result.current.books)).toEqual([
      [NEW_Y, BoolFlag.TRUE],
      [OTHER_K, BoolFlag.FALSE],
    ]);
    expect(result.current.dirtyBookIds.has(OLD_X)).toBe(true);
    expect(result.current.dirtyBookIds.has(NEW_Y)).toBe(false);
  });
});

// #250: a save may clear only the dirty ids it really saved, never a mid-flight
// edit's mark. See the file header.
describe("usePersonalBooks — a share change made while a save is in flight (#250)", () => {
  const MID_A = bookIdOf(40);
  const MID_B = bookIdOf(41);
  const MID_C = bookIdOf(42);

  beforeEach(() => {
    vi.clearAllMocks();
    setupStorage();
  });

  /** Server holds A (not shared), B (shared), C (not shared). */
  async function renderHeld() {
    const held = heldPatch();
    const client = clientWithServerBooks(
      [makeBook(MID_A), makeBook(MID_B, BoolFlag.TRUE), makeBook(MID_C)],
      { patchPersonalBooks: held.patch },
    );
    const hook = renderUsePersonalBooks(client);
    await waitForReady(hook.result);
    return { ...hook, client, ...held };
  }

  /** Start a save and leave it in flight (the promise is returned wrapped). */
  async function startSave(result: {
    current: { handleSave: () => Promise<void>; status: string };
  }): Promise<{ pending: Promise<void> }> {
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.handleSave();
    });
    expect(result.current.status).toBe("saving");
    return { pending };
  }

  /** Share A, save (held open), un-share A mid-save, let the save succeed. */
  async function shareAThenRevertMidSave() {
    const hook = await renderHeld();
    act(() => {
      hook.result.current.handleToggle(MID_A);
    });
    const { pending } = await startSave(hook.result);
    expect(hook.patch.mock.calls[0][1]).toEqual([
      { bookId: MID_A, isShared: BoolFlag.TRUE },
    ]);

    act(() => {
      hook.result.current.handleToggle(MID_A);
    });
    await act(async () => {
      hook.release();
      await pending;
    });
    expect(hook.result.current.status).toBe("saved");
    return hook;
  }

  it("keeps a book reverted mid-save unsaved, then saves the revert on the next save", async () => {
    const { result, patch, client } = await shareAThenRevertMidSave();

    // The screen shows A not shared and still marks it unsaved…
    expect(result.current.books.find((b) => b.bookId === MID_A)?.isShared).toBe(
      BoolFlag.FALSE,
    );
    expect([...result.current.dirtyBookIds]).toEqual([MID_A]);
    expect(result.current.isDirty).toBe(true);
    // …while the server (and the Cancel baseline) holds the sent share.
    expect(
      result.current.originalBooks.current.find((b) => b.bookId === MID_A)
        ?.isShared,
    ).toBe(BoolFlag.TRUE);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: MID_A, isShared: BoolFlag.FALSE },
    ]);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });

  it("restores the server's share on Cancel after a mid-save revert", async () => {
    const { result } = await shareAThenRevertMidSave();

    act(() => {
      result.current.handleCancel();
    });

    expect(flagsOf(result.current.books)).toEqual([
      [MID_A, BoolFlag.TRUE],
      [MID_B, BoolFlag.TRUE],
      [MID_C, BoolFlag.FALSE],
    ]);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });

  it("keeps another book toggled mid-save unsaved and clears the one that was sent", async () => {
    const { result, patch, release } = await renderHeld();
    act(() => {
      result.current.handleToggle(MID_A);
    });
    const { pending } = await startSave(result);

    act(() => {
      result.current.handleToggle(MID_C);
    });
    await act(async () => {
      release();
      await pending;
    });

    expect([...result.current.dirtyBookIds]).toEqual([MID_C]);
    expect(result.current.isDirty).toBe(true);
    expect(flagsOf(result.current.books)).toEqual([
      [MID_A, BoolFlag.TRUE],
      [MID_B, BoolFlag.TRUE],
      [MID_C, BoolFlag.TRUE],
    ]);

    await act(async () => {
      await result.current.handleSave();
    });
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: MID_C, isShared: BoolFlag.TRUE },
    ]);
  });

  it("keeps a batch change made mid-save unsaved", async () => {
    const { result, patch, release } = await renderHeld();
    act(() => {
      result.current.handleToggle(MID_A);
    });
    const { pending } = await startSave(result);

    // PersonalShelf's batch hide: setBooks over the selection + markManyDirty.
    const selected = new Set([MID_A, MID_B]);
    act(() => {
      result.current.setBooks((prev) =>
        prev.map((b) =>
          selected.has(b.bookId) ? { ...b, isShared: BoolFlag.FALSE } : b,
        ),
      );
      result.current.markManyDirty(selected);
    });
    await act(async () => {
      release();
      await pending;
    });

    expect([...result.current.dirtyBookIds].sort()).toEqual(
      [MID_A, MID_B].sort(),
    );
    expect(flagsOf(result.current.books)).toEqual([
      [MID_A, BoolFlag.FALSE],
      [MID_B, BoolFlag.FALSE],
      [MID_C, BoolFlag.FALSE],
    ]);

    await act(async () => {
      await result.current.handleSave();
    });
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: MID_A, isShared: BoolFlag.FALSE },
      { bookId: MID_B, isShared: BoolFlag.FALSE },
    ]);
  });

  it("clears every sent id when nothing changed during the save", async () => {
    const { result, release } = await renderHeld();
    act(() => {
      result.current.handleToggle(MID_A);
      result.current.handleToggle(MID_C);
    });
    const { pending } = await startSave(result);

    await act(async () => {
      release();
      await pending;
    });

    expect(result.current.status).toBe("saved");
    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it("clears a book toggled twice mid-save (back to the value that was sent)", async () => {
    const { result, patch, release } = await renderHeld();
    act(() => {
      result.current.handleToggle(MID_A);
    });
    const { pending } = await startSave(result);

    act(() => {
      result.current.handleToggle(MID_A);
    });
    act(() => {
      result.current.handleToggle(MID_A);
    });
    await act(async () => {
      release();
      await pending;
    });

    expect(result.current.books.find((b) => b.bookId === MID_A)?.isShared).toBe(
      BoolFlag.TRUE,
    );
    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("clears an untouched sent id but keeps a mid-save revert when a sync also lands mid-save", async () => {
    const { result, rerender, patch, release, client } = await renderHeld();
    act(() => {
      result.current.handleToggle(MID_A);
      result.current.handleToggle(MID_C);
    });
    const { pending } = await startSave(result);
    expect(patch.mock.calls[0][1]).toEqual([
      { bookId: MID_A, isShared: BoolFlag.TRUE },
      { bookId: MID_C, isShared: BoolFlag.TRUE },
    ]);

    // The sync result is the server's view (pre-save flags) plus a new book.
    const NEW_D = bookIdOf(43);
    await act(async () => {
      rerender({
        lastSyncBooks: [
          makeBook(MID_A),
          makeBook(MID_B, BoolFlag.TRUE),
          makeBook(MID_C),
          makeBook(NEW_D),
        ],
      });
    });
    // Unsaved toggles survive the sync on screen.
    expect(flagsOf(result.current.books)).toEqual([
      [MID_A, BoolFlag.TRUE],
      [MID_B, BoolFlag.TRUE],
      [MID_C, BoolFlag.TRUE],
      [NEW_D, BoolFlag.FALSE],
    ]);

    // Un-share C before the save comes back.
    act(() => {
      result.current.handleToggle(MID_C);
    });
    await act(async () => {
      release();
      await pending;
    });

    expect([...result.current.dirtyBookIds]).toEqual([MID_C]);
    expect(result.current.books.find((b) => b.bookId === MID_C)?.isShared).toBe(
      BoolFlag.FALSE,
    );
    // Baseline = the sync result with the sent flags folded in.
    expect(flagsOf(result.current.originalBooks.current)).toEqual([
      [MID_A, BoolFlag.TRUE],
      [MID_B, BoolFlag.TRUE],
      [MID_C, BoolFlag.TRUE],
      [NEW_D, BoolFlag.FALSE],
    ]);

    await act(async () => {
      await result.current.handleSave();
    });
    expect(client.updatePersonalBooks).not.toHaveBeenCalled();
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: MID_C, isShared: BoolFlag.FALSE },
    ]);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });
});
