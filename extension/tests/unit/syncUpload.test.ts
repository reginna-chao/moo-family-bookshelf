import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only the DOM scraper is replaced; merge, breaker, id-change resolution and
// the conflict retry all run for real.
vi.mock("@/content/scraper", () => ({
  scrapeLibrary: vi.fn(),
  scrapeArchivedBooks: vi.fn(),
}));

import { syncBooks } from "@/sync/syncBooks";
import { SYNC_PAUSED_MESSAGE } from "@/sync/syncBreaker";
import {
  BOOKS_CONFLICT_MESSAGE,
  BOOKS_TOO_LARGE_MESSAGE,
} from "moo-family-bookshelf-shared/personal/saveErrors";
import {
  scrapeLibrary,
  scrapeArchivedBooks,
  type ScrapedBook,
} from "@/content/scraper";
import {
  BoolFlag,
  type ApiClient,
  type BookEntry,
  type BorrowRequest,
} from "@/api/client";
import { LAST_SYNC_AT_KEY } from "@/constants";

/**
 * Lost-update guard of the sync upload (#249, `sync/syncUpload.ts`), driven
 * through `syncBooks`. The sync reads the saved list, merges it with the scrape
 * and PUTs the whole record; a share-toggle save landing between that read and
 * the PUT used to be overwritten with the stale flag. The PUT now carries the
 * read `lastUpdated` as `expectedLastUpdated`; the Worker answers 409
 * BOOKS_CONFLICT when it no longer matches, and the sync re-reads and rebuilds
 * (at most 3 PUTs in total).
 *
 * The fake server below honours that contract like the Worker does: the
 * precondition is optional, a mismatch writes nothing, and every accepted write
 * gets a fresh server-assigned `lastUpdated`. PUT bodies are logged as the
 * JSON wire body (`ApiClient.updatePersonalBooks` sends `JSON.stringify(data)`).
 */

const USER_ID = "user-123";
const FAMILY_ID = "fam-1";
const BOOK_A = "210000000000011";
const BOOK_B = "210000000000012";
const KEPT_ID = "210000000000003";
const OLD_ID = "210000000000001";
const NEW_ID = "210000000000002";
const RENAMED_TITLE = "改了編號的書";
const READ_STAMP = "2026-09-30T10:00:00.000Z";

/** The Worker's wire code and message for a failed precondition (worker/src/routes/user.ts). */
const WORKER_CONFLICT_ERROR = {
  code: "BOOKS_CONFLICT",
  message: "Books record changed since it was read",
};

function scrapedBook(bookId: string, title = `書${bookId}`): ScrapedBook {
  return {
    bookId,
    title,
    author: "作者",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isArchived: BoolFlag.FALSE,
  };
}

function savedBook(
  bookId: string,
  isShared: BoolFlag = BoolFlag.FALSE,
  title = `書${bookId}`,
): BookEntry {
  return {
    bookId,
    title,
    author: "作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isShared,
    isArchived: BoolFlag.FALSE,
  };
}

type StoredRecord = Record<string, unknown> & { books: BookEntry[] };
type WireBody = Record<string, unknown> & { books: BookEntry[] };

function storedRecord(
  books: BookEntry[],
  lastUpdated: unknown = READ_STAMP,
): StoredRecord {
  return {
    schemaVersion: 1,
    userId: USER_ID,
    displayName: "小明",
    books,
    lastUpdated,
  };
}

interface ServerState {
  stored: StoredRecord | null;
}

interface FakeServerOptions {
  /** Runs as PUT #index arrives, before the precondition check: a save landing mid-sync. */
  beforePut?: (index: number, state: ServerState) => void;
  /** A scripted answer for GET #index; undefined serves the stored record. */
  scriptedGet?: (index: number) => unknown;
  /** Every PUT fails with this error envelope. */
  putError?: { code: unknown; message: unknown };
  /** `data` of an accepted PUT, given the stored record; default `{ ok: true }`. */
  putData?: (stored: StoredRecord) => unknown;
}

interface PutLog {
  body: WireBody;
  outcome: "ok" | "conflict" | "error";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createFakeServer(
  initial: StoredRecord | null,
  options: FakeServerOptions = {},
) {
  const state: ServerState = { stored: initial ? clone(initial) : null };
  let writes = 0;
  let getCount = 0;
  const puts: PutLog[] = [];
  /** The `lastUpdated` each GET served (undefined when it served no record). */
  const servedStamps: unknown[] = [];

  const getPersonalBooks = vi.fn(async () => {
    const scripted = options.scriptedGet?.(getCount);
    getCount += 1;
    if (scripted !== undefined) return scripted;
    servedStamps.push(state.stored?.lastUpdated);
    return { data: state.stored ? clone(state.stored) : null };
  });

  const updatePersonalBooks = vi.fn(async (_userId: string, data: unknown) => {
    const body = clone(data) as WireBody;
    options.beforePut?.(puts.length, state);
    if (options.putError) {
      puts.push({ body, outcome: "error" });
      return { error: options.putError };
    }
    const expected = body.expectedLastUpdated;
    const conditional = typeof expected === "string" && expected !== "";
    if (conditional && state.stored?.lastUpdated !== expected) {
      puts.push({ body, outcome: "conflict" });
      return { error: WORKER_CONFLICT_ERROR };
    }
    const record = { ...body };
    delete record.expectedLastUpdated;
    writes += 1;
    const stored = { ...record, lastUpdated: `server-write-${writes}` };
    state.stored = stored;
    puts.push({ body, outcome: "ok" });
    return {
      data: options.putData ? options.putData(clone(stored)) : { ok: true },
    };
  });

  const listBorrowRequests = vi.fn(async (): Promise<BorrowRequest[]> => []);
  const updateBorrowStatus = vi.fn();
  const client = {
    getPersonalBooks,
    updatePersonalBooks,
    listBorrowRequests,
    updateBorrowStatus,
  } as unknown as ApiClient;

  return {
    client,
    state,
    puts,
    servedStamps,
    getPersonalBooks,
    updatePersonalBooks,
    listBorrowRequests,
    updateBorrowStatus,
  };
}

/** A save from another surface lands: book `bookId` gets `isShared`, and a new stamp. */
function saveLands(
  state: ServerState,
  bookId: string,
  isShared: BoolFlag,
  stamp: string,
): void {
  if (!state.stored) throw new Error("fake server has no record to save over");
  state.stored = {
    ...state.stored,
    books: state.stored.books.map((b) =>
      b.bookId === bookId ? { ...b, isShared } : b,
    ),
    lastUpdated: stamp,
  };
}

function isSharedOf(books: BookEntry[], bookId: string): BoolFlag | undefined {
  return books.find((b) => b.bookId === bookId)?.isShared;
}

function mockScrape(books: ScrapedBook[]): void {
  vi.mocked(scrapeLibrary).mockResolvedValue({ books, complete: true });
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

function runSync(client: ApiClient, withFamily = true) {
  return syncBooks({
    navigate: false,
    userId: USER_ID,
    apiClient: client,
    ...(withFamily ? { familyId: FAMILY_ID } : {}),
  });
}

describe("uploadSyncBooksRereadingOnConflict (via syncBooks)", () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    await chrome.storage.local.clear();
    window.location.hash = "";
  });

  describe("a share toggle saved between the sync's read and its upload (#249)", () => {
    it("uploads the toggled flag, never the stale one it read", async () => {
      mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
      const toggleStamp = "2026-09-30T10:00:05.000Z";
      const server = createFakeServer(
        storedRecord([savedBook(BOOK_A, BoolFlag.TRUE), savedBook(BOOK_B)]),
        {
          // The user un-shares A from the shelf while the sync is in flight.
          beforePut: (index, state) => {
            if (index === 0)
              saveLands(state, BOOK_A, BoolFlag.FALSE, toggleStamp);
          },
        },
      );

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
      // The first PUT was built from the stale read: A shared, read stamp.
      expect(server.puts[0].body.expectedLastUpdated).toBe(READ_STAMP);
      expect(isSharedOf(server.puts[0].body.books, BOOK_A)).toBe(BoolFlag.TRUE);
      // The PUT that landed was rebuilt from the re-read.
      const landed = server.puts[1].body;
      expect(landed.expectedLastUpdated).toBe(toggleStamp);
      expect(isSharedOf(landed.books, BOOK_A)).toBe(BoolFlag.FALSE);
      const acceptedFlags = server.puts
        .filter((p) => p.outcome === "ok")
        .map((p) => isSharedOf(p.body.books, BOOK_A));
      expect(acceptedFlags).not.toContain(BoolFlag.TRUE);
      expect(isSharedOf(server.state.stored?.books ?? [], BOOK_A)).toBe(
        BoolFlag.FALSE,
      );
      expect(isSharedOf(result.books, BOOK_A)).toBe(BoolFlag.FALSE);
    });
  });

  describe("the expectedLastUpdated precondition", () => {
    it("sends the read lastUpdated unchanged when it is a non-empty string", async () => {
      mockScrape([scrapedBook(BOOK_A)]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]));

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(server.puts).toHaveLength(1);
      expect(server.puts[0].body).toHaveProperty(
        "expectedLastUpdated",
        READ_STAMP,
      );
      // The record's own lastUpdated is the client's write time, not the precondition.
      expect(server.puts[0].body.lastUpdated).not.toBe(READ_STAMP);
    });

    const MISSING = Symbol("missing");
    it.each([
      { name: "there is no saved record", lastUpdated: null, noRecord: true },
      { name: "the record has no lastUpdated", lastUpdated: MISSING },
      { name: "lastUpdated is an empty string", lastUpdated: "" },
      { name: "lastUpdated is a number", lastUpdated: 1727690400000 },
      { name: "lastUpdated is null", lastUpdated: null },
      { name: "lastUpdated is an object", lastUpdated: { at: READ_STAMP } },
      { name: "lastUpdated is a boolean", lastUpdated: true },
    ])(
      "leaves expectedLastUpdated out of the PUT body when $name",
      async ({ lastUpdated, noRecord }) => {
        mockScrape([scrapedBook(BOOK_A)]);
        const record = storedRecord([savedBook(BOOK_A)], lastUpdated);
        if (lastUpdated === MISSING) delete record.lastUpdated;
        const server = createFakeServer(noRecord ? null : record);

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts).toHaveLength(1);
        expect(server.puts[0].body).not.toHaveProperty("expectedLastUpdated");
        // Positive companion: the body really is the uploaded record.
        expect(server.puts[0].body.books.map((b) => b.bookId)).toEqual([
          BOOK_A,
        ]);
      },
    );
  });

  describe("conflicts that clear before the attempt limit", () => {
    it.each([{ conflicts: 1 }, { conflicts: 2 }])(
      "re-reads and rebuilds after each of $conflicts conflict(s), reusing the scrape and borrow list",
      async ({ conflicts }) => {
        mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
        const server = createFakeServer(
          storedRecord([savedBook(BOOK_A, BoolFlag.TRUE), savedBook(BOOK_B)]),
          {
            // Each racing save flips A, so every read differs from the last.
            beforePut: (index, state) => {
              if (index >= conflicts) return;
              const flag = index % 2 === 0 ? BoolFlag.FALSE : BoolFlag.TRUE;
              saveLands(state, BOOK_A, flag, `toggle-${index}`);
            },
          },
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts.map((p) => p.outcome)).toEqual([
          ...Array<string>(conflicts).fill("conflict"),
          "ok",
        ]);
        // One GET per attempt; each PUT carries the stamp of the read before it …
        expect(server.getPersonalBooks).toHaveBeenCalledTimes(conflicts + 1);
        expect(server.puts.map((p) => p.body.expectedLastUpdated)).toEqual(
          server.servedStamps,
        );
        // … and was merged from that read (A's flag tracks each racing save).
        const expectedFlags = [BoolFlag.TRUE, BoolFlag.FALSE, BoolFlag.TRUE];
        expect(
          server.puts.map((p) => isSharedOf(p.body.books, BOOK_A)),
        ).toEqual(expectedFlags.slice(0, conflicts + 1));
        expect(result.books).toEqual(server.puts[conflicts].body.books);
        // Read-independent steps run once per sync, not once per attempt.
        expect(scrapeLibrary).toHaveBeenCalledTimes(1);
        expect(server.listBorrowRequests).toHaveBeenCalledTimes(1);
        expect(wroteLastSyncAt()).toBe(true);
      },
    );

    it.each([
      {
        name: "drops a rename found only by the stale attempt",
        firstServer: [
          savedBook(KEPT_ID),
          savedBook(OLD_ID, BoolFlag.TRUE, RENAMED_TITLE),
        ],
        // Another device's sync already replaced OLD with NEW (and shared KEPT).
        racingServer: [
          savedBook(KEPT_ID, BoolFlag.TRUE),
          savedBook(NEW_ID, BoolFlag.TRUE, RENAMED_TITLE),
        ],
        renamedBooks: [],
      },
      {
        name: "reports a rename found only by the attempt that landed",
        firstServer: [savedBook(KEPT_ID)],
        // Another device uploaded OLD meanwhile; this scrape lists it as NEW.
        racingServer: [
          savedBook(KEPT_ID, BoolFlag.TRUE),
          savedBook(OLD_ID, BoolFlag.TRUE, RENAMED_TITLE),
        ],
        renamedBooks: [{ oldId: OLD_ID, newId: NEW_ID }],
      },
    ])(
      "returns books and renamedBooks of the landed attempt: $name",
      async ({ firstServer, racingServer, renamedBooks }) => {
        mockScrape([scrapedBook(KEPT_ID), scrapedBook(NEW_ID, RENAMED_TITLE)]);
        const server = createFakeServer(storedRecord(firstServer), {
          beforePut: (index, state) => {
            if (index === 0) state.stored = storedRecord(racingServer, "race");
          },
        });

        const result = await runSync(server.client, false);

        expect(result.success).toBe(true);
        expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
        expect(result.renamedBooks).toEqual(renamedBooks);
        expect(result.renamedBookCount).toBe(renamedBooks.length);
        expect(result.books).toEqual(server.puts[1].body.books);
        expect(result.books.map((b) => b.bookId)).toEqual([KEPT_ID, NEW_ID]);
        // KEPT's flag comes from the re-read, not the first read.
        expect(isSharedOf(result.books, KEPT_ID)).toBe(BoolFlag.TRUE);
        expect(isSharedOf(server.puts[0].body.books, KEPT_ID)).toBe(
          BoolFlag.FALSE,
        );
      },
    );
  });

  // #259 C1: the stamp the landed PUT answered travels with the sync result,
  // so the dialog's next full PUT is conditioned on the sync's own write.
  describe("the landed PUT's lastUpdated", () => {
    it("returns the stamp the Worker answered for the stored record", async () => {
      mockScrape([scrapedBook(BOOK_A)]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]), {
        putData: (stored) => stored,
      });

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(result.lastUpdated).toBe("server-write-1");
      expect(result.lastUpdated).toBe(server.state.stored?.lastUpdated);
    });

    it("returns the stamp of the attempt that landed after a conflict", async () => {
      mockScrape([scrapedBook(BOOK_A)]);
      const toggleStamp = "2026-09-30T10:00:05.000Z";
      const server = createFakeServer(
        storedRecord([savedBook(BOOK_A, BoolFlag.TRUE)]),
        {
          beforePut: (index, state) => {
            if (index === 0)
              saveLands(state, BOOK_A, BoolFlag.FALSE, toggleStamp);
          },
          putData: (stored) => stored,
        },
      );

      const result = await runSync(server.client);

      expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
      // Neither the first read's stamp nor the re-read's: the landed write's.
      expect(result.lastUpdated).toBe("server-write-1");
      expect(result.lastUpdated).not.toBe(READ_STAMP);
      expect(result.lastUpdated).not.toBe(toggleStamp);
      expect(result.books).toEqual(server.puts[1].body.books);
    });

    it.each<{ name: string; data: unknown }>([
      { name: "{ ok: true }, with no usable lastUpdated", data: { ok: true } },
      { name: "a record with no lastUpdated", data: { books: [] } },
      { name: "an empty lastUpdated", data: { lastUpdated: "" } },
      { name: "a numeric lastUpdated", data: { lastUpdated: 1727690400000 } },
      { name: "null data", data: null },
      { name: "no data", data: undefined },
    ])("returns no stamp when the PUT answers $name", async ({ data }) => {
      mockScrape([scrapedBook(BOOK_A)]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]), {
        putData: () => data,
      });

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(result.lastUpdated).toBeUndefined();
      // Positive companion: the sync really landed its list.
      expect(result.books.map((b) => b.bookId)).toEqual([BOOK_A]);
    });

    it("returns no stamp when the sync fails", async () => {
      mockScrape([scrapedBook(BOOK_A)]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]), {
        putError: { code: "INTERNAL_ERROR", message: "伺服器忙碌" },
        putData: (stored) => stored,
      });

      const result = await runSync(server.client);

      expect(result.success).toBe(false);
      expect(result).not.toHaveProperty("lastUpdated");
    });
  });

  describe("a list that keeps changing", () => {
    it("gives up after 3 conflicting PUTs with the conflict copy, restoring navigation", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      window.location.hash = "#/settings";
      mockScrape([scrapedBook(BOOK_A)]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]), {
        beforePut: (index, state) =>
          saveLands(
            state,
            BOOK_A,
            index % 2 === 0 ? BoolFlag.TRUE : BoolFlag.FALSE,
            `toggle-${index}`,
          ),
      });

      const pending = syncBooks({
        navigate: true,
        userId: USER_ID,
        apiClient: server.client,
        familyId: FAMILY_ID,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toEqual({
        success: false,
        books: [],
        error: BOOKS_CONFLICT_MESSAGE,
      });
      expect(server.puts.map((p) => p.outcome)).toEqual([
        "conflict",
        "conflict",
        "conflict",
      ]);
      // No re-read after the last conflict: nothing would use it.
      expect(server.getPersonalBooks).toHaveBeenCalledTimes(3);
      expect(wroteLastSyncAt()).toBe(false);
      expect(window.location.hash).toBe("#/settings");
      expect(server.updateBorrowStatus).not.toHaveBeenCalled();
    });
  });

  describe("errors that are not a conflict", () => {
    it.each([
      {
        name: "a 500 INTERNAL_ERROR",
        error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" },
        shown: "伺服器忙碌",
      },
      {
        name: "a 413 PAYLOAD_TOO_LARGE",
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body exceeds 2MB limit",
        },
        shown: BOOKS_TOO_LARGE_MESSAGE,
      },
      {
        name: "a near-miss lowercase conflict code",
        error: { code: "books_conflict", message: "changed" },
        shown: "changed",
      },
    ])(
      "fails after a single PUT and no re-read on $name",
      async ({ error, shown }) => {
        mockScrape([scrapedBook(BOOK_A)]);
        const server = createFakeServer(storedRecord([savedBook(BOOK_A)]), {
          putError: error,
        });

        const result = await runSync(server.client);

        expect(result).toEqual({ success: false, books: [], error: shown });
        expect(server.updatePersonalBooks).toHaveBeenCalledTimes(1);
        expect(server.getPersonalBooks).toHaveBeenCalledTimes(1);
        expect(wroteLastSyncAt()).toBe(false);
      },
    );
  });

  describe("a re-read that cannot be used", () => {
    it.each([
      {
        name: "the re-read fails",
        options: {
          beforePut: (index: number, state: ServerState) => {
            if (index === 0) saveLands(state, BOOK_A, BoolFlag.TRUE, "toggle");
          },
          scriptedGet: (index: number) =>
            index === 1
              ? { error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" } }
              : undefined,
        },
        shown: "伺服器忙碌",
      },
      {
        name: "the re-read trips the circuit breaker",
        options: {
          // The list now holds 50 real-id books this scrape never saw.
          beforePut: (index: number, state: ServerState) => {
            if (index !== 0) return;
            const books = Array.from({ length: 50 }, (_, i) =>
              savedBook(`2100000${String(500 + i).padStart(8, "0")}`),
            );
            state.stored = storedRecord(books, "race");
          },
        },
        shown: SYNC_PAUSED_MESSAGE,
      },
    ])("aborts with no further PUT when $name", async ({ options, shown }) => {
      mockScrape([scrapedBook(BOOK_A)]);
      const server = createFakeServer(
        storedRecord([savedBook(BOOK_A)]),
        options,
      );

      const result = await runSync(server.client);

      expect(result).toEqual({ success: false, books: [], error: shown });
      expect(server.puts.map((p) => p.outcome)).toEqual(["conflict"]);
      expect(server.getPersonalBooks).toHaveBeenCalledTimes(2);
      expect(wroteLastSyncAt()).toBe(false);
      expect(server.updateBorrowStatus).not.toHaveBeenCalled();
    });

    it("fails with the conflict and no unconditional PUT when the re-read finds no record (#265)", async () => {
      mockScrape([scrapedBook(BOOK_A)]);
      const server = createFakeServer(
        storedRecord([savedBook(BOOK_A, BoolFlag.TRUE)]),
        {
          beforePut: (index, state) => {
            if (index === 0) saveLands(state, BOOK_A, BoolFlag.TRUE, "toggle");
          },
          scriptedGet: (index) => (index === 1 ? { data: null } : undefined),
        },
      );

      const result = await runSync(server.client);

      expect(result).toEqual({
        success: false,
        books: [],
        error: BOOKS_CONFLICT_MESSAGE,
      });
      // A retry built on the empty read would reset A to not-shared.
      expect(server.puts.map((p) => p.outcome)).toEqual(["conflict"]);
      expect(isSharedOf(server.state.stored?.books ?? [], BOOK_A)).toBe(
        BoolFlag.TRUE,
      );
      expect(wroteLastSyncAt()).toBe(false);
    });
  });
});
