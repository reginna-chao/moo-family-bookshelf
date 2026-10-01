import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

/**
 * `syncBooks` reconciliation (#236): the order scrape → GET saved → breaker →
 * borrow list (once) → merge → id-change resolution → PUT → lastSyncAt →
 * auto-return. A failed read or a tripped breaker must stop BEFORE any upload;
 * id-change resolution only runs on a complete scrape with a known borrow list.
 */

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

function mockScrape(books: ScrapedBook[], complete = true): void {
  vi.mocked(scrapeLibrary).mockResolvedValue({ books, complete });
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
      // Nothing after the read runs: no borrow list, no auto-return.
      expect(api.listBorrowRequests).not.toHaveBeenCalled();
      expect(api.updateBorrowStatus).not.toHaveBeenCalled();
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

    it("keeps the old id when the library scrape is incomplete", async () => {
      mockScrape(SCRAPED_BOOKS, false);
      const api = createApi(serverRecord(SERVER_BOOKS), []);

      const result = await runSync(api, true);

      expect(result.success).toBe(true);
      expect(result.renamedBookCount).toBe(0);
      expect(result.renamedBooks).toEqual([]);
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID, OLD_ID]);
    });

    it("keeps the old id when archive sync is on but the archive scrape is incomplete", async () => {
      await chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });
      vi.mocked(scrapeArchivedBooks).mockResolvedValue({
        books: [],
        complete: false,
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
      expect(uploadedIds(api)).toEqual([KEPT_ID, NEW_ID, OLD_ID]);
      expect(result.autoReturnedRequestIds).toEqual([]);
      expect(api.updateBorrowStatus).not.toHaveBeenCalled();
      expect(api.listBorrowRequests).toHaveBeenCalledTimes(1);
      expect(wroteLastSyncAt()).toBe(true);
    });
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
