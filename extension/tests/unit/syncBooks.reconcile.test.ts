import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `syncBooks` reconciliation (#236): the order GET saved (prune candidates) →
 * scrape → GET saved (upload basis) → breaker → borrow list (once) → merge →
 * id-change resolution → pruning (#241) → PUT → lastSyncAt → auto-return. A
 * failed pre-scrape read must stop BEFORE the scrape, a tripped breaker before
 * any upload; id-change resolution and pruning only run on a complete scrape
 * with a known borrow list.
 *
 * Pruning may only remove books the pre-scrape GET held: a book another device
 * stores while this sync scrapes, or between its first PUT and the 409 re-read,
 * is absent from the scrape yet must survive with its share flag. The
 * "a book another device stores mid-sync" block drives that race through a fake
 * server that honours `expectedLastUpdated` like the Worker.
 *
 * The upload basis is the POST-scrape read, never the pre-scrape one: the
 * Worker's `PUT /family-prefs` keeps the stored `lastUpdated`, so a sync PUT
 * spread from the pre-scrape record would pass its precondition and silently
 * overwrite family-shelf prefs saved during the scrape. "the upload basis" pins
 * the first PUT to the post-scrape record's prefs and stamp.
 *
 * Two consecutive syncs — F2 regression (#236): a sync that cannot judge renames
 * must leave the pair resolvable by the next one. The fake server stores exactly
 * what each PUT received and serves it to the next GET.
 */

// Only the DOM scraper is replaced; merge, circuit breaker and id-change
// resolution all run for real so the whole upload decision is exercised.
vi.mock("@/content/scraper", () => ({
  scrapeLibrary: vi.fn(),
  scrapeArchivedBooks: vi.fn(),
}));

import { syncBooks } from "@/sync/syncBooks";
import { SYNC_PAUSED_MESSAGE } from "@/sync/syncBreaker";
import {
  scrapeLibrary,
  scrapeArchivedBooks,
  type ScrapedBook,
} from "@/content/scraper";
import {
  BoolFlag,
  BorrowStatus,
  type ApiClient,
  type BookEntry,
  type BorrowRequest,
  type PersonalBooks,
} from "@/api/client";
import { LAST_SYNC_AT_KEY, SYNC_ARCHIVED_KEY } from "@/constants";

const USER_ID = "user-123";
const FAMILY_ID = "fam-1";
const OLD_ID = "210000000000001";
const NEW_ID = "210000000000002";
const KEPT_ID = "210000000000003";
const RENAMED_TITLE = "改了編號的書";

function scrapedBook(
  bookId: string,
  title: string,
  isArchived = BoolFlag.FALSE,
): ScrapedBook {
  return {
    bookId,
    title,
    author: "作者",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isArchived,
  };
}

function savedBook(
  bookId: string,
  title: string,
  overrides: Partial<BookEntry> = {},
): BookEntry {
  return {
    bookId,
    title,
    author: "作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isShared: BoolFlag.FALSE,
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

/** Server holds KEPT + the OLD id (shared); Readmoo now lists KEPT + NEW. */
const SERVER_BOOKS = [
  savedBook(KEPT_ID, "沒變的書"),
  savedBook(OLD_ID, RENAMED_TITLE, { isShared: BoolFlag.TRUE }),
];
const SCRAPED_BOOKS = [
  scrapedBook(KEPT_ID, "沒變的書"),
  scrapedBook(NEW_ID, RENAMED_TITLE),
];

function makeLentRequest(
  bookId: string,
  overrides: Partial<BorrowRequest> = {},
): BorrowRequest {
  return {
    requestId: `req-${bookId}`,
    familyId: FAMILY_ID,
    borrowerId: "user-borrower",
    borrowerName: "借書人",
    ownerId: USER_ID,
    bookId,
    bookTitle: "書",
    bookAuthor: "",
    bookCoverUrl: "",
    status: BorrowStatus.LENT,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface MockApi {
  client: ApiClient;
  getPersonalBooks: ReturnType<typeof vi.fn>;
  updatePersonalBooks: ReturnType<typeof vi.fn>;
  listBorrowRequests: ReturnType<typeof vi.fn>;
  updateBorrowStatus: ReturnType<typeof vi.fn>;
}

function createApi(
  getResponse: unknown,
  requests: BorrowRequest[] | Error = [],
): MockApi {
  const getPersonalBooks = vi.fn().mockResolvedValue(getResponse);
  const updatePersonalBooks = vi.fn().mockResolvedValue({ data: { ok: true } });
  const listBorrowRequests =
    requests instanceof Error
      ? vi.fn().mockRejectedValue(requests)
      : vi.fn().mockResolvedValue(requests);
  const updateBorrowStatus = vi
    .fn()
    .mockImplementation(async (requestId: string) => ({
      ...makeLentRequest(OLD_ID),
      requestId,
      status: BorrowStatus.RETURNED,
    }));
  const client = {
    getPersonalBooks,
    updatePersonalBooks,
    listBorrowRequests,
    updateBorrowStatus,
  } as unknown as ApiClient;
  return {
    client,
    getPersonalBooks,
    updatePersonalBooks,
    listBorrowRequests,
    updateBorrowStatus,
  };
}

function serverRecord(books: BookEntry[]) {
  return { data: { books, displayName: "小明", keepMe: "unknown-field" } };
}

function mockScrape(
  books: ScrapedBook[],
  complete = true,
  libraryIds: ReadonlySet<string> | null = null,
): void {
  vi.mocked(scrapeLibrary).mockResolvedValue({ books, complete, libraryIds });
}

function uploadedPayload(api: MockApi): PersonalBooks {
  expect(api.updatePersonalBooks).toHaveBeenCalledTimes(1);
  return api.updatePersonalBooks.mock.calls[0][1] as PersonalBooks;
}

function uploadedIds(api: MockApi): string[] {
  return uploadedPayload(api).books.map((b) => b.bookId);
}

function wroteLastSyncAt(): boolean {
  return vi
    .mocked(chrome.storage.local.set)
    .mock.calls.some(
      (call) =>
        call[0] !== null &&
        typeof call[0] === "object" &&
        LAST_SYNC_AT_KEY in (call[0] as Record<string, unknown>),
    );
}

const HOLD_BACK_WARNING =
  "[moo] renames cannot be judged this sync; held back possible renamed books";

/** The detail argument of every hold-back warning logged so far. */
function holdBackWarnings(): unknown[] {
  return vi
    .mocked(console.warn)
    .mock.calls.filter((call) => call[0] === HOLD_BACK_WARNING)
    .map((call) => call[1]);
}

async function runSync(api: MockApi, withFamily: boolean) {
  return syncBooks({
    navigate: false,
    userId: USER_ID,
    apiClient: api.client,
    ...(withFamily ? { familyId: FAMILY_ID } : {}),
  });
}

describe("syncBooks — reconciliation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
    window.location.hash = "#/library";
    vi.mocked(scrapeArchivedBooks).mockResolvedValue({
      books: [],
      complete: true,
      libraryIds: null,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await chrome.storage.local.clear();
    window.location.hash = "";
  });

  describe("failed read of the saved list", () => {
    it("fails the sync with no upload and no lastSyncAt", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi({
        error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" },
      });

      const result = await runSync(api, true);

      expect(result).toEqual({
        success: false,
        books: [],
        error: "伺服器忙碌",
      });
      expect(api.updatePersonalBooks).not.toHaveBeenCalled();
      expect(wroteLastSyncAt()).toBe(false);
      // Nothing after the read runs: no scrape, no borrow list, no auto-return.
      expect(scrapeLibrary).not.toHaveBeenCalled();
      expect(api.listBorrowRequests).not.toHaveBeenCalled();
      expect(api.updateBorrowStatus).not.toHaveBeenCalled();
    });

    it("fails the sync without scraping when the read itself rejects", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi(serverRecord(SERVER_BOOKS));
      api.getPersonalBooks.mockRejectedValue(new Error("網路中斷"));

      const result = await runSync(api, true);

      expect(result).toEqual({ success: false, books: [], error: "網路中斷" });
      expect(scrapeLibrary).not.toHaveBeenCalled();
      expect(api.updatePersonalBooks).not.toHaveBeenCalled();
      expect(wroteLastSyncAt()).toBe(false);
    });

    it("reads the saved list before it scrapes, and again after it", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi(serverRecord(SERVER_BOOKS));

      const result = await runSync(api, false);

      expect(result.success).toBe(true);
      expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);
      const scrapeOrder = vi.mocked(scrapeLibrary).mock.invocationCallOrder[0];
      expect(api.getPersonalBooks.mock.invocationCallOrder[0]).toBeLessThan(
        scrapeOrder,
      );
      expect(api.getPersonalBooks.mock.invocationCallOrder[1]).toBeGreaterThan(
        scrapeOrder,
      );
    });

    it("uploads the scrape as a first sync when the record is simply absent", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi({ data: null });

      const result = await runSync(api, false);

      expect(result.success).toBe(true);
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID]);
      // Positive companion of the "no lastSyncAt" assertion above.
      expect(wroteLastSyncAt()).toBe(true);
    });
  });

  // See the header → "The upload basis is the POST-scrape read".
  describe("the upload basis", () => {
    const PRE_STAMP = "2026-10-01T00:00:00.000Z";
    const PREFS_BEFORE = { hidden: ["owner-a:1"], favorites: [] };
    const PREFS_DURING = { hidden: [], favorites: ["owner-b:2"] };

    it.each([
      {
        name: "keeps the stored stamp (as the Worker does)",
        postStamp: PRE_STAMP,
      },
      { name: "bumps the stamp", postStamp: "2026-10-01T00:00:07.000Z" },
    ])(
      "uploads family-shelf prefs saved during the scrape when that save $name",
      async ({ postStamp }) => {
        mockScrape(SCRAPED_BOOKS);
        const api = createApi(serverRecord(SERVER_BOOKS));
        const record = (prefs: object, lastUpdated: string) => ({
          data: {
            ...serverRecord(SERVER_BOOKS).data,
            familyShelfPrefs: prefs,
            lastUpdated,
          },
        });
        api.getPersonalBooks
          .mockResolvedValueOnce(record(PREFS_BEFORE, PRE_STAMP))
          .mockResolvedValueOnce(record(PREFS_DURING, postStamp));

        const result = await runSync(api, false);

        expect(result.success).toBe(true);
        const body = uploadedPayload(api) as PersonalBooks & {
          expectedLastUpdated?: string;
        };
        expect(body.familyShelfPrefs).toEqual(PREFS_DURING);
        expect(body.expectedLastUpdated).toBe(postStamp);
      },
    );
  });

  describe("circuit breaker", () => {
    /** 50 real-id server books; the scrape only finds the first `found`. */
    function bigLibrary(found: number) {
      const server = Array.from({ length: 50 }, (_, i) =>
        savedBook(`2100000${String(100 + i).padStart(8, "0")}`, `書${i}`),
      );
      const scraped = server
        .slice(0, found)
        .map((b) => scrapedBook(b.bookId, b.title));
      return { server, scraped };
    }

    it("pauses a redesign-shaped scrape: no upload, no lastSyncAt, no auto-return", async () => {
      const { server, scraped } = bigLibrary(10);
      mockScrape(scraped);
      const api = createApi(serverRecord(server), [
        makeLentRequest(server[0].bookId),
      ]);

      const result = await runSync(api, true);

      expect(result).toEqual({
        success: false,
        books: [],
        error: SYNC_PAUSED_MESSAGE,
      });
      expect(api.updatePersonalBooks).not.toHaveBeenCalled();
      expect(wroteLastSyncAt()).toBe(false);
      expect(api.listBorrowRequests).not.toHaveBeenCalled();
      expect(api.updateBorrowStatus).not.toHaveBeenCalled();
    });

    it("lets a scrape that found half of the saved books through", async () => {
      const { server, scraped } = bigLibrary(25);
      mockScrape(scraped);
      const api = createApi(serverRecord(server));

      const result = await runSync(api, false);

      expect(result.success).toBe(true);
      expect(api.updatePersonalBooks).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        name: "archive sync is off",
        syncArchived: BoolFlag.FALSE,
        archiveComplete: true,
      },
      {
        name: "the archive scrape failed",
        syncArchived: BoolFlag.TRUE,
        archiveComplete: false,
      },
    ])(
      "does not count saved archived books against the scrape when $name",
      async ({ syncArchived, archiveComplete }) => {
        await chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: syncArchived });
        vi.mocked(chrome.storage.local.set).mockClear();
        vi.mocked(scrapeArchivedBooks).mockResolvedValue({
          books: [],
          complete: archiveComplete,
          libraryIds: null,
        });
        // 20 active (all found) + 60 archived (not scraped this time).
        const active = Array.from({ length: 20 }, (_, i) =>
          savedBook(`2100000${String(300 + i).padStart(8, "0")}`, `在架${i}`),
        );
        const archived = Array.from({ length: 60 }, (_, i) =>
          savedBook(`2100000${String(400 + i).padStart(8, "0")}`, `封存${i}`, {
            isArchived: BoolFlag.TRUE,
          }),
        );
        mockScrape(active.map((b) => scrapedBook(b.bookId, b.title)));
        const api = createApi(serverRecord([...active, ...archived]));

        const result = await runSync(api, false);

        expect(result.success).toBe(true);
        // Additive: every archived saved book is still uploaded.
        expect(uploadedIds(api)).toHaveLength(80);
      },
    );
  });

  describe("id-change resolution", () => {
    it("uploads the list without the old id and reports the count", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi(serverRecord(SERVER_BOOKS), []);

      const result = await runSync(api, true);

      expect(result.success).toBe(true);
      expect(result.renamedBookCount).toBe(1);
      expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID]);
      const payload = uploadedPayload(api);
      // The old entry was shared → the new id inherits it.
      expect(payload.books.find((b) => b.bookId === NEW_ID)?.isShared).toBe(
        BoolFlag.TRUE,
      );
      // Unknown fields of the saved record survive the PUT.
      expect((payload as unknown as Record<string, unknown>).keepMe).toBe(
        "unknown-field",
      );
      // The returned list IS what was uploaded.
      expect(result.books).toEqual(payload.books);
      expect(api.listBorrowRequests).toHaveBeenCalledTimes(1);
    });

    it("also resolves without a family (no borrow list needed)", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi(serverRecord(SERVER_BOOKS));

      const result = await runSync(api, false);

      expect(result.renamedBookCount).toBe(1);
      expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID]);
      expect(api.listBorrowRequests).not.toHaveBeenCalled();
    });

    it("keeps the old id and holds back its same-title new id when the library scrape is incomplete", async () => {
      mockScrape(SCRAPED_BOOKS, false);
      const api = createApi(serverRecord(SERVER_BOOKS), []);

      const result = await runSync(api, true);

      expect(result.success).toBe(true);
      expect(result.renamedBookCount).toBe(0);
      expect(result.renamedBooks).toEqual([]);
      // NEW is held back: not uploaded, so a later complete sync still sees it
      // as brand-new and can pair it with OLD.
      expect(uploadedIds(api)).toEqual([KEPT_ID, OLD_ID]);
      expect(result.books.map((b) => b.bookId)).toEqual([KEPT_ID, OLD_ID]);
      expect(holdBackWarnings()).toEqual([{ deferredCount: 1 }]);
    });

    it("keeps the old id when archive sync is on but the archive scrape is incomplete", async () => {
      await chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });
      vi.mocked(scrapeArchivedBooks).mockResolvedValue({
        books: [],
        complete: false,
        libraryIds: null,
      });
      mockScrape(SCRAPED_BOOKS);
      const api = createApi(serverRecord(SERVER_BOOKS));

      const result = await runSync(api, false);

      expect(result.renamedBookCount).toBe(0);
      expect(uploadedIds(api)).toContain(OLD_ID);
    });

    it("keeps the old id while it is lent out", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi(serverRecord(SERVER_BOOKS), [
        makeLentRequest(OLD_ID),
      ]);

      const result = await runSync(api, true);

      expect(result.renamedBookCount).toBe(0);
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID, OLD_ID]);
    });

    it("skips resolution and auto-return, but still uploads, when the borrow list is unavailable", async () => {
      mockScrape(SCRAPED_BOOKS);
      const api = createApi(
        serverRecord(SERVER_BOOKS),
        new Error("borrow list down"),
      );

      const result = await runSync(api, true);

      expect(result.success).toBe(true);
      expect(result.renamedBookCount).toBe(0);
      expect(result.renamedBooks).toEqual([]);
      // The rename candidate NEW is held back; everything else is uploaded.
      expect(uploadedIds(api)).toEqual([KEPT_ID, OLD_ID]);
      expect(result.books.map((b) => b.bookId)).toEqual([KEPT_ID, OLD_ID]);
      expect(holdBackWarnings()).toEqual([{ deferredCount: 1 }]);
      expect(result.autoReturnedRequestIds).toEqual([]);
      expect(api.updateBorrowStatus).not.toHaveBeenCalled();
      expect(api.listBorrowRequests).toHaveBeenCalledTimes(1);
      expect(wroteLastSyncAt()).toBe(true);
    });

    it("uploads the scrape unchanged (no hold-back warning) when an incomplete scrape has no rename candidate", async () => {
      const scraped = [
        scrapedBook(KEPT_ID, "沒變的書"),
        scrapedBook(NEW_ID, "全新的書"),
      ];
      mockScrape(scraped, false);
      const api = createApi(serverRecord(SERVER_BOOKS), []);

      const result = await runSync(api, true);

      expect(result.success).toBe(true);
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID, OLD_ID]);
      expect(holdBackWarnings()).toEqual([]);
    });

    it("still auto-returns a LENT request for a held-back id (auto-return sees the real scraped ids)", async () => {
      mockScrape(SCRAPED_BOOKS, false);
      const api = createApi(serverRecord(SERVER_BOOKS), [
        makeLentRequest(NEW_ID),
      ]);

      const result = await runSync(api, true);

      // NEW is held back from the upload …
      expect(uploadedIds(api)).not.toContain(NEW_ID);
      expect(holdBackWarnings()).toEqual([{ deferredCount: 1 }]);
      // … but it WAS on the page, so its LENT request is marked returned.
      expect(api.updateBorrowStatus).toHaveBeenCalledWith(
        `req-${NEW_ID}`,
        BorrowStatus.RETURNED,
      );
      expect(result.autoReturnedRequestIds).toEqual([`req-${NEW_ID}`]);
    });
  });

  // #241: pruning runs after id-change resolution, under the same gates.
  describe("pruning books Readmoo no longer holds", () => {
    const GONE_ID = "210000000000004";
    const LOANED_ID = "210000000000005";
    /** KEPT is on the shelf, LOANED only in Readmoo's loaned list, GONE nowhere. */
    const PRUNE_SERVER = [
      savedBook(KEPT_ID, "沒變的書"),
      savedBook(GONE_ID, "退款的書", { isShared: BoolFlag.TRUE }),
      savedBook(LOANED_ID, "借給別人的書"),
    ];
    const PRUNE_SCRAPE = [scrapedBook(KEPT_ID, "沒變的書")];
    const LIBRARY_IDS = new Set([KEPT_ID, LOANED_ID]);

    it("uploads the list without the gone book and reports the removed counts", async () => {
      mockScrape(PRUNE_SCRAPE, true, LIBRARY_IDS);
      const api = createApi(serverRecord(PRUNE_SERVER), []);

      const result = await runSync(api, true);

      expect(result.success).toBe(true);
      expect(uploadedIds(api)).toEqual([KEPT_ID, LOANED_ID]);
      expect(result.books.map((b) => b.bookId)).toEqual([KEPT_ID, LOANED_ID]);
      expect(result.removedBooks).toEqual([
        { bookId: GONE_ID, isShared: BoolFlag.TRUE },
      ]);
      expect(result.removedBookCount).toBe(1);
      expect(result.removedSharedCount).toBe(1);
      expect(result.renamedBookCount).toBe(0);
    });

    it.each([
      {
        name: "the scrape is incomplete",
        complete: false,
        requests: [] as BorrowRequest[] | Error,
      },
      {
        name: "the borrow list is unavailable",
        complete: true,
        requests: new Error("borrow list down") as BorrowRequest[] | Error,
      },
    ])("removes nothing when $name", async ({ complete, requests }) => {
      mockScrape(PRUNE_SCRAPE, complete, LIBRARY_IDS);
      const api = createApi(serverRecord(PRUNE_SERVER), requests);

      const result = await runSync(api, true);

      expect(result.success).toBe(true);
      expect(uploadedIds(api)).toEqual([KEPT_ID, GONE_ID, LOANED_ID]);
      expect(result.removedBookCount).toBe(0);
      expect(result.removedSharedCount).toBe(0);
      expect(result.removedBooks).toEqual([]);
    });

    it("keeps the gone book while it is lent out through MooFamily", async () => {
      mockScrape(PRUNE_SCRAPE, true, LIBRARY_IDS);
      const api = createApi(serverRecord(PRUNE_SERVER), [
        makeLentRequest(GONE_ID),
      ]);

      const result = await runSync(api, true);

      expect(uploadedIds(api)).toEqual([KEPT_ID, GONE_ID, LOANED_ID]);
      expect(result.removedBookCount).toBe(0);
    });

    it("reports a renamed old id as renamed, not removed", async () => {
      mockScrape(SCRAPED_BOOKS, true, new Set([KEPT_ID, NEW_ID]));
      const api = createApi(serverRecord(SERVER_BOOKS), []);

      const result = await runSync(api, true);

      expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
      expect(result.removedBookCount).toBe(0);
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID]);
    });
  });

  // See the header → "Pruning may only remove books the pre-scrape GET held".
  describe("a book another device stores mid-sync", () => {
    const Y_ID = "210000000000006";
    const X_BOOK = savedBook(KEPT_ID, "沒變的書");
    const PRE_SCRAPE_STAMP = "2026-10-01T00:00:00.000Z";

    interface ConflictState {
      books: BookEntry[];
      lastUpdated: string;
    }

    /** Stores what a PUT sends; a stale `expectedLastUpdated` writes nothing and answers 409. */
    function createConflictServer(
      initial: BookEntry[],
      beforePut?: (index: number, state: ConflictState) => void,
    ) {
      const state: ConflictState = {
        books: initial,
        lastUpdated: PRE_SCRAPE_STAMP,
      };
      const puts: Array<{ books: BookEntry[]; conflict: boolean }> = [];
      const getPersonalBooks = vi.fn(async () => ({
        data: JSON.parse(
          JSON.stringify({ ...state, displayName: "小明" }),
        ) as PersonalBooks,
      }));
      const updatePersonalBooks = vi.fn(
        async (_userId: string, payload: PersonalBooks) => {
          const body = JSON.parse(JSON.stringify(payload)) as PersonalBooks & {
            expectedLastUpdated?: string;
          };
          beforePut?.(puts.length, state);
          const conflict = body.expectedLastUpdated !== state.lastUpdated;
          puts.push({ books: body.books, conflict });
          if (conflict) {
            return {
              error: {
                code: "BOOKS_CONFLICT",
                message: "Books record changed since it was read",
              },
            };
          }
          state.books = body.books;
          state.lastUpdated = `server-write-${puts.length}`;
          return { data: { ok: true } };
        },
      );
      const client = {
        getPersonalBooks,
        updatePersonalBooks,
        listBorrowRequests: vi.fn(async () => []),
        updateBorrowStatus: vi.fn(),
      } as unknown as ApiClient;
      return { client, state, puts, getPersonalBooks };
    }

    /** Another device's sync stores Y (shared) — Readmoo on THIS device does not list it. */
    function otherDeviceStoresY(state: ConflictState): void {
      state.books = [
        ...state.books,
        savedBook(Y_ID, "另一台裝置的書", { isShared: BoolFlag.TRUE }),
      ];
      state.lastUpdated = "2026-10-01T00:00:05.000Z";
    }

    function syncWith(client: ApiClient) {
      return syncBooks({
        navigate: false,
        userId: USER_ID,
        apiClient: client,
        familyId: FAMILY_ID,
      });
    }

    /** `conflicts`: the outcome of each PUT; the last one is the landed one. */
    function expectYKeptShared(
      result: Awaited<ReturnType<typeof syncBooks>>,
      server: ReturnType<typeof createConflictServer>,
      conflicts: boolean[],
    ): void {
      expect(result.success).toBe(true);
      expect(server.puts.map((p) => p.conflict)).toEqual(conflicts);
      const landed = server.puts[conflicts.length - 1].books;
      expect(landed.map((b) => b.bookId)).toEqual([KEPT_ID, Y_ID]);
      expect(landed.find((b) => b.bookId === Y_ID)?.isShared).toBe(
        BoolFlag.TRUE,
      );
      expect(result.books).toEqual(landed);
      expect(result.removedBookCount).toBe(0);
      expect(result.removedBooks).toEqual([]);
      expect(result.removedSharedCount).toBe(0);
    }

    it("keeps a shared book stored between the first PUT and its conflict re-read", async () => {
      mockScrape([scrapedBook(KEPT_ID, "沒變的書")], true, new Set([KEPT_ID]));
      const server = createConflictServer([X_BOOK], (index, state) => {
        if (index === 0) otherDeviceStoresY(state);
      });

      const result = await syncWith(server.client);

      expectYKeptShared(result, server, [true, false]);
      // Pre-scrape read, post-scrape read, conflict re-read.
      expect(server.getPersonalBooks).toHaveBeenCalledTimes(3);
    });

    it("keeps a shared book stored while this device was scraping", async () => {
      const server = createConflictServer([X_BOOK]);
      vi.mocked(scrapeLibrary).mockImplementation(async () => {
        otherDeviceStoresY(server.state);
        return {
          books: [scrapedBook(KEPT_ID, "沒變的書")],
          complete: true,
          libraryIds: new Set([KEPT_ID]),
        };
      });

      const result = await syncWith(server.client);

      // The post-scrape read already holds Y, so the first PUT lands; Y stays outside the
      // pre-scrape prune candidates, so it is kept although this scrape never saw it.
      expectYKeptShared(result, server, [false]);
      expect(server.getPersonalBooks).toHaveBeenCalledTimes(2);
    });
  });

  // F2 regression (#236): an unjudged rename stays resolvable by the next sync;
  // the fake server replays each PUT on the next GET.
  describe("two consecutive syncs", () => {
    const OLD_SHARED = savedBook(OLD_ID, RENAMED_TITLE, {
      isShared: BoolFlag.TRUE,
    });
    const SCRAPE_NEW = [scrapedBook(NEW_ID, RENAMED_TITLE)];

    function createFakeServer(
      initial: BookEntry[],
      borrowLists: Array<BorrowRequest[] | Error>,
    ) {
      let stored: BookEntry[] = initial;
      const puts: BookEntry[][] = [];
      const getPersonalBooks = vi.fn(async () => serverRecord(stored));
      const updatePersonalBooks = vi.fn(
        async (_userId: string, payload: PersonalBooks) => {
          stored = payload.books;
          puts.push(payload.books);
          return { data: { ok: true } };
        },
      );
      const listBorrowRequests = vi.fn(async () => {
        const next = borrowLists.shift() ?? [];
        if (next instanceof Error) throw next;
        return next;
      });
      const client = {
        getPersonalBooks,
        updatePersonalBooks,
        listBorrowRequests,
        updateBorrowStatus: vi.fn(),
      } as unknown as ApiClient;
      return { client, puts };
    }

    async function sync(client: ApiClient) {
      return syncBooks({
        navigate: false,
        userId: USER_ID,
        apiClient: client,
        familyId: FAMILY_ID,
      });
    }

    it.each([
      {
        name: "the first scrape is incomplete",
        firstComplete: false,
        firstBorrow: [] as BorrowRequest[] | Error,
      },
      {
        name: "the first sync cannot read the borrow list",
        firstComplete: true,
        firstBorrow: new Error("borrow list down") as BorrowRequest[] | Error,
      },
    ])(
      "resolves the rename on the second sync when $name",
      async ({ firstComplete, firstBorrow }) => {
        const server = createFakeServer([OLD_SHARED], [firstBorrow, []]);

        mockScrape(SCRAPE_NEW, firstComplete);
        const first = await sync(server.client);

        expect(first.success).toBe(true);
        expect(first.renamedBookCount).toBe(0);
        // Only OLD is uploaded; NEW stays brand-new for the next sync.
        expect(server.puts[0].map((b) => b.bookId)).toEqual([OLD_ID]);

        mockScrape(SCRAPE_NEW, true);
        const second = await sync(server.client);

        expect(second.success).toBe(true);
        expect(second.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
        expect(second.renamedBookCount).toBe(1);
        expect(server.puts[1]).toHaveLength(1);
        expect(server.puts[1][0].bookId).toBe(NEW_ID);
        expect(server.puts[1][0].isShared).toBe(BoolFlag.TRUE);
      },
    );
  });

  it("fetches the borrow list once and reuses it for auto-return", async () => {
    // KEPT_ID is LENT and was scraped back → auto-returned.
    mockScrape(SCRAPED_BOOKS);
    const api = createApi(serverRecord(SERVER_BOOKS), [
      makeLentRequest(KEPT_ID),
    ]);

    const result = await runSync(api, true);

    expect(result.success).toBe(true);
    expect(api.listBorrowRequests).toHaveBeenCalledTimes(1);
    expect(api.listBorrowRequests).toHaveBeenCalledWith(FAMILY_ID);
    expect(api.updateBorrowStatus).toHaveBeenCalledWith(
      `req-${KEPT_ID}`,
      BorrowStatus.RETURNED,
    );
    expect(result.autoReturnedRequestIds).toEqual([`req-${KEPT_ID}`]);
    // The borrow list is read before the upload (it gates the resolution).
    expect(api.listBorrowRequests.mock.invocationCallOrder[0]).toBeLessThan(
      api.updatePersonalBooks.mock.invocationCallOrder[0],
    );
  });
});
