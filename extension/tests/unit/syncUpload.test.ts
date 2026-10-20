import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
 *
 * 新書預設開放 (#238, `sync/autoShare.ts`): the upload of each attempt marks
 * books new to the server as shared when that attempt's read carries
 * `newBookDefaultShared: 1` (the Worker's GET merges the setting into the
 * record; the fake server simply stores it on the record). Because the setting
 * and the server's book ids are both read per attempt, a 409 re-read recomputes
 * them: a setting turned off mid-sync shares nothing, and a book another device
 * uploaded meanwhile is no longer new. Rename targets, books carrying the
 * title of a saved book the scrape missed (an id change left unpaired, e.g.
 * because the old copy is lent out) and archived books are never auto-shared.
 * Neither is a book the read lists in the server-owned `removedUnsharedBookIds`
 * (#312: removed while NOT shared, so it comes back unshared); that list is
 * read per attempt too.
 *
 * Text-field caps (#326, `sync/fieldCaps.ts`): the Worker refuses the whole
 * PUT when one entry's title, author or category is over its cap, so each
 * attempt fits the scrape against THAT attempt's read before the merge. A book
 * the read does not hold is left out when its TITLE is over the cap (counted
 * in `fieldCapSkippedCount`), and otherwise uploaded with each over-cap author
 * or category sent as `""` (counted in `fieldCapBlankedCount`) — an ordinary
 * new book in every other respect, auto-shared by 新書預設開放 like any other.
 * A book the read holds is uploaded with the saved value in place of each
 * over-cap author or category, and its over-cap title, changed or not,
 * replaced by `OVER_CAP_TITLE_PLACEHOLDER` (never a cut or a pre-cap stored
 * title, either of which could equal a legacy entry's title and take its
 * share flag), keeping its share flag. The counts are the landed attempt's.
 *
 * Same-title books: a blanked book keeps its title, so it takes part in every
 * same-title step (rename pairing, legacy resolution) exactly as if it fit.
 * No new book is held back for sharing a title and no saved book's new title
 * is reverted — an earlier rule did both, and each variant could leave a
 * shared legacy entry with ONE real same-title twin on the server, which the
 * Personal Shelf load (`dropResolvedLegacyBooks` on the saved list) resolved
 * onto, moving its share flag to a book never chosen. The "same-title steps"
 * group replays those cases and runs that load rule on the uploaded body.
 *
 * A left-out title still counts in the same-title steps (`skippedTitles`), but
 * since the Worker accepts no new over-cap title, only a title stored before
 * the caps existed can equal one: such a saved book is never pruned, and its
 * same-title legacy entry is not resolved this sync. Since a saved book's
 * pre-cap over-cap title is sent as the placeholder, that legacy entry never
 * resolves onto its real twin afterwards either — the accepted cost (less
 * sharing, never more), and why a left-out copy cannot move it at load.
 * A saved book NOT scraped this sync still sends its stored, possibly pre-cap
 * title, so `dropResolvedLegacyBooks` never resolves a legacy entry whose
 * title is over the cap at all — at sync or at load.
 */

// Only the DOM scraper is replaced; merge, breaker, id-change resolution and
// the conflict retry all run for real.
vi.mock("@/content/scraper", () => ({
  scrapeLibrary: vi.fn(),
  scrapeArchivedBooks: vi.fn(),
}));

import { syncBooks } from "@/sync/syncBooks";
import { dropResolvedLegacyBooks } from "@/sync/legacyBooks";
import { OVER_CAP_TITLE_PLACEHOLDER } from "@/sync/fieldCaps";
import { SYNC_PAUSED_MESSAGE } from "@/sync/syncBreaker";
import {
  BOOKS_CONFLICT_MESSAGE,
  BOOKS_INVALID_PAYLOAD_MESSAGE,
  BOOKS_TOO_LARGE_MESSAGE,
} from "moo-family-bookshelf-shared/personal/saveErrors";
import {
  BOOK_AUTHOR_MAX_LENGTH,
  BOOK_TITLE_MAX_LENGTH,
} from "moo-family-bookshelf-shared/api/bookFieldLimits";
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
} from "@/api/client";
import { LAST_SYNC_AT_KEY, SYNC_ARCHIVED_KEY } from "@/constants";

const USER_ID = "user-123";
const FAMILY_ID = "fam-1";
const BOOK_A = "210000000000011";
const BOOK_B = "210000000000012";
const GONE_ID = "210000000000013";
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

function mockScrape(
  books: ScrapedBook[],
  libraryIds: ReadonlySet<string> | null = null,
): void {
  vi.mocked(scrapeLibrary).mockResolvedValue({
    books,
    complete: true,
    libraryIds,
  });
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
      libraryIds: null,
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
        // The pre-scrape GET, then one per attempt; each PUT carries the stamp of the read before it …
        expect(server.getPersonalBooks).toHaveBeenCalledTimes(conflicts + 2);
        expect(server.puts.map((p) => p.body.expectedLastUpdated)).toEqual(
          server.servedStamps.slice(1),
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

    // #241: the removed books are recomputed from each re-read, like the renames.
    it.each([
      {
        name: "drops a removal found only by the stale attempt",
        firstServer: [savedBook(BOOK_A), savedBook(GONE_ID, BoolFlag.TRUE)],
        // Another device's sync already removed GONE.
        racingServer: [savedBook(BOOK_A, BoolFlag.TRUE)],
        firstPutIds: [BOOK_A],
        landedIds: [BOOK_A],
        removedBooks: [],
        removedSharedCount: 0,
      },
      {
        name: "keeps a book first seen in the re-read (added after the scrape began), share flag intact",
        firstServer: [savedBook(BOOK_A)],
        // Another device uploaded GONE meanwhile; the pre-scrape read never held it.
        racingServer: [
          savedBook(BOOK_A, BoolFlag.TRUE),
          savedBook(GONE_ID, BoolFlag.TRUE),
        ],
        firstPutIds: [BOOK_A],
        landedIds: [BOOK_A, GONE_ID],
        removedBooks: [],
        removedSharedCount: 0,
      },
      {
        name: "still removes a pre-scrape book the re-read holds too",
        firstServer: [savedBook(BOOK_A), savedBook(GONE_ID, BoolFlag.TRUE)],
        racingServer: [
          savedBook(BOOK_A, BoolFlag.TRUE),
          savedBook(GONE_ID, BoolFlag.TRUE),
        ],
        firstPutIds: [BOOK_A],
        landedIds: [BOOK_A],
        removedBooks: [{ bookId: GONE_ID, isShared: BoolFlag.TRUE }],
        removedSharedCount: 1,
      },
    ])(
      "returns the removed books of the landed attempt: $name",
      async ({
        firstServer,
        racingServer,
        firstPutIds,
        landedIds,
        removedBooks,
        removedSharedCount,
      }) => {
        mockScrape([scrapedBook(BOOK_A)], new Set([BOOK_A]));
        const server = createFakeServer(storedRecord(firstServer), {
          beforePut: (index, state) => {
            if (index === 0) state.stored = storedRecord(racingServer, "race");
          },
        });

        const result = await runSync(server.client, false);

        expect(result.success).toBe(true);
        expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
        expect(server.puts[0].body.books.map((b) => b.bookId)).toEqual(
          firstPutIds,
        );
        expect(result.removedBooks).toEqual(removedBooks);
        expect(result.removedBookCount).toBe(removedBooks.length);
        expect(result.removedSharedCount).toBe(removedSharedCount);
        expect(result.books).toEqual(server.puts[1].body.books);
        expect(result.books.map((b) => b.bookId)).toEqual(landedIds);
        // A book the landed PUT keeps keeps the re-read's share flag.
        for (const id of landedIds) {
          expect(isSharedOf(result.books, id)).toBe(BoolFlag.TRUE);
        }
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
      // Pre- and post-scrape reads plus two re-reads; none after the last conflict.
      expect(server.getPersonalBooks).toHaveBeenCalledTimes(4);
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
        // #326: the Worker's English field-cap message never reaches the shelf.
        name: "a 400 INVALID_PAYLOAD over a field cap",
        error: {
          code: "INVALID_PAYLOAD",
          message: "Each book's author must be at most 500 characters",
        },
        shown: BOOKS_INVALID_PAYLOAD_MESSAGE,
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
        // Only the pre- and post-scrape reads.
        expect(server.getPersonalBooks).toHaveBeenCalledTimes(2);
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
          // GET 0 / 1 are the pre- and post-scrape reads; GET 2 is the re-read.
          scriptedGet: (index: number) =>
            index === 2
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
      expect(server.getPersonalBooks).toHaveBeenCalledTimes(3);
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
          // GET 2 is the conflict re-read (0 / 1 are the pre- and post-scrape reads).
          scriptedGet: (index) => (index === 2 ? { data: null } : undefined),
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

  // #238: the setting and the server ids come from each attempt's read. See the header → "新書預設開放".
  describe("新書預設開放 (auto-share new books)", () => {
    function withSetting(record: StoredRecord, flag: unknown): StoredRecord {
      return { ...record, newBookDefaultShared: flag };
    }

    it("uploads a book new to the server as shared when the stored setting is 1, and counts it", async () => {
      mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
      const server = createFakeServer(
        withSetting(storedRecord([savedBook(BOOK_A)]), BoolFlag.TRUE),
      );

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      const body = server.puts[0].body;
      expect(isSharedOf(body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      // The book the server already held keeps its own (unshared) flag.
      expect(isSharedOf(body.books, BOOK_A)).toBe(BoolFlag.FALSE);
      expect(result.autoSharedCount).toBe(1);
      expect(result.autoShareHeldCount).toBe(0);
      expect(isSharedOf(result.books, BOOK_B)).toBe(BoolFlag.TRUE);
    });

    it.each([
      { name: "0", flag: BoolFlag.FALSE },
      { name: "absent", flag: undefined },
      { name: "true (not a BoolFlag)", flag: true },
      { name: '"1" (not a BoolFlag)', flag: "1" },
    ])(
      "leaves the new book unshared when the stored setting is $name",
      async ({ flag }) => {
        mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
        const record = storedRecord([savedBook(BOOK_A)]);
        const server = createFakeServer(
          flag === undefined ? record : withSetting(record, flag),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(isSharedOf(server.puts[0].body.books, BOOK_B)).toBe(
          BoolFlag.FALSE,
        );
        expect(result.autoSharedCount).toBe(0);
        expect(result.autoShareHeldCount).toBe(0);
      },
    );

    it("never auto-shares on the first sync, even with the setting on", async () => {
      mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
      const server = createFakeServer(
        withSetting(storedRecord([]), BoolFlag.TRUE),
      );

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(server.puts[0].body.books.map((b) => b.isShared)).toEqual([
        BoolFlag.FALSE,
        BoolFlag.FALSE,
      ]);
      expect(result.autoSharedCount).toBe(0);
    });

    it.each([
      {
        name: "turned off between the reads: the landed PUT shares nothing",
        first: BoolFlag.TRUE,
        reread: BoolFlag.FALSE,
        firstShared: BoolFlag.TRUE,
        landedShared: BoolFlag.FALSE,
        count: 0,
      },
      {
        name: "turned on between the reads: the landed PUT shares the new book",
        first: BoolFlag.FALSE,
        reread: BoolFlag.TRUE,
        firstShared: BoolFlag.FALSE,
        landedShared: BoolFlag.TRUE,
        count: 1,
      },
    ])(
      "recomputes the setting from the 409 re-read — $name",
      async ({ first, reread, firstShared, landedShared, count }) => {
        mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
        const server = createFakeServer(
          withSetting(storedRecord([savedBook(BOOK_A)]), first),
          {
            beforePut: (index, state) => {
              if (index !== 0) return;
              state.stored = withSetting(
                storedRecord([savedBook(BOOK_A)], "race"),
                reread,
              );
            },
          },
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
        expect(isSharedOf(server.puts[0].body.books, BOOK_B)).toBe(firstShared);
        expect(isSharedOf(server.puts[1].body.books, BOOK_B)).toBe(
          landedShared,
        );
        expect(result.autoSharedCount).toBe(count);
      },
    );

    it("treats a book the 409 re-read already holds as not new", async () => {
      mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
      const server = createFakeServer(
        withSetting(storedRecord([savedBook(BOOK_A)]), BoolFlag.TRUE),
        {
          // Another device uploaded B (unshared) between this sync's read and its PUT.
          beforePut: (index, state) => {
            if (index !== 0) return;
            state.stored = withSetting(
              storedRecord([savedBook(BOOK_A), savedBook(BOOK_B)], "race"),
              BoolFlag.TRUE,
            );
          },
        },
      );

      const result = await runSync(server.client);

      expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
      expect(isSharedOf(server.puts[0].body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      expect(isSharedOf(server.puts[1].body.books, BOOK_B)).toBe(
        BoolFlag.FALSE,
      );
      expect(result.autoSharedCount).toBe(0);
    });

    it("does not auto-share the target of a rename, while sharing a genuinely new book", async () => {
      mockScrape([
        scrapedBook(KEPT_ID),
        scrapedBook(NEW_ID, RENAMED_TITLE),
        scrapedBook(BOOK_B),
      ]);
      const server = createFakeServer(
        withSetting(
          storedRecord([
            savedBook(KEPT_ID),
            savedBook(OLD_ID, BoolFlag.FALSE, RENAMED_TITLE),
          ]),
          BoolFlag.TRUE,
        ),
      );

      const result = await runSync(server.client, false);

      expect(result.success).toBe(true);
      expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
      const body = server.puts[0].body;
      expect(isSharedOf(body.books, NEW_ID)).toBe(BoolFlag.FALSE);
      // Positive companion: the run did auto-share, so the exclusion is not vacuous.
      expect(isSharedOf(body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      expect(result.autoSharedCount).toBe(1);
    });

    it("does not auto-share a book titled like a saved book the scrape missed when the id change is not paired", async () => {
      mockScrape([
        scrapedBook(KEPT_ID),
        scrapedBook(NEW_ID, RENAMED_TITLE),
        scrapedBook(BOOK_B),
      ]);
      const server = createFakeServer(
        withSetting(
          storedRecord([
            savedBook(KEPT_ID),
            savedBook(OLD_ID, BoolFlag.FALSE, RENAMED_TITLE),
          ]),
          BoolFlag.TRUE,
        ),
      );
      // OLD is lent out, which shields it from id-change resolution: NEW is never paired with it.
      server.listBorrowRequests.mockResolvedValue([
        {
          requestId: "req-old",
          familyId: FAMILY_ID,
          borrowerId: "user-borrower",
          borrowerName: "借書人",
          ownerId: USER_ID,
          bookId: OLD_ID,
          bookTitle: RENAMED_TITLE,
          bookAuthor: "",
          bookCoverUrl: "",
          status: BorrowStatus.LENT,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ]);

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(result.renamedBooks).toEqual([]);
      const body = server.puts[0].body;
      expect(isSharedOf(body.books, NEW_ID)).toBe(BoolFlag.FALSE);
      // Positive companion: the genuinely new book IS auto-shared.
      expect(isSharedOf(body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      expect(result.autoSharedCount).toBe(1);
    });

    it("does not auto-share a new archived book synced by 同步封存書籍", async () => {
      await chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });
      mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
      vi.mocked(scrapeArchivedBooks).mockResolvedValue({
        books: [{ ...scrapedBook(GONE_ID), isArchived: BoolFlag.TRUE }],
        complete: true,
        libraryIds: null,
      });
      const server = createFakeServer(
        withSetting(storedRecord([savedBook(BOOK_A)]), BoolFlag.TRUE),
      );

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      const archived = server.puts[0].body.books.find(
        (b) => b.bookId === GONE_ID,
      );
      expect(archived).toMatchObject({
        isArchived: BoolFlag.TRUE,
        isShared: BoolFlag.FALSE,
      });
      expect(isSharedOf(server.puts[0].body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      expect(result.autoSharedCount).toBe(1);
    });

    it("keeps a book the server lists as removed while unshared unshared when the scrape brings it back (#312)", async () => {
      mockScrape([
        scrapedBook(BOOK_A),
        scrapedBook(GONE_ID),
        scrapedBook(BOOK_B),
      ]);
      const server = createFakeServer({
        ...withSetting(storedRecord([savedBook(BOOK_A)]), BoolFlag.TRUE),
        removedUnsharedBookIds: [GONE_ID],
      });

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      const body = server.puts[0].body;
      expect(isSharedOf(body.books, GONE_ID)).toBe(BoolFlag.FALSE);
      // Positive companion: the genuinely new book IS auto-shared.
      expect(isSharedOf(body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      expect(result.autoSharedCount).toBe(1);
      expect(result.autoShareHeldCount).toBe(0);
    });

    it("recomputes the removed-while-unshared list from the 409 re-read (#312)", async () => {
      mockScrape([
        scrapedBook(BOOK_A),
        scrapedBook(GONE_ID),
        scrapedBook(BOOK_B),
      ]);
      const server = createFakeServer(
        withSetting(storedRecord([savedBook(BOOK_A)]), BoolFlag.TRUE),
        {
          // Another device removed GONE (unshared) between this sync's read and its PUT.
          beforePut: (index, state) => {
            if (index !== 0) return;
            state.stored = {
              ...withSetting(
                storedRecord([savedBook(BOOK_A)], "race"),
                BoolFlag.TRUE,
              ),
              removedUnsharedBookIds: [GONE_ID],
            };
          },
        },
      );

      const result = await runSync(server.client);

      expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
      expect(isSharedOf(server.puts[0].body.books, GONE_ID)).toBe(
        BoolFlag.TRUE,
      );
      expect(isSharedOf(server.puts[1].body.books, GONE_ID)).toBe(
        BoolFlag.FALSE,
      );
      expect(isSharedOf(server.puts[1].body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      expect(result.autoSharedCount).toBe(1);
    });

    it("shares none of more than 100 new books and reports them held", async () => {
      const fresh = Array.from(
        { length: 101 },
        (_, i) => `2108${String(i).padStart(11, "0")}`,
      );
      mockScrape([scrapedBook(BOOK_A), ...fresh.map((id) => scrapedBook(id))]);
      const server = createFakeServer(
        withSetting(storedRecord([savedBook(BOOK_A)]), BoolFlag.TRUE),
      );

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(
        server.puts[0].body.books.filter((b) => b.isShared === BoolFlag.TRUE),
      ).toEqual([]);
      expect(result.autoSharedCount).toBe(0);
      expect(result.autoShareHeldCount).toBe(101);
    });
  });

  // See the header → "Text-field caps".
  describe("books over the server's text-field caps (#326)", () => {
    const OVER_CAP_TITLE = "長".repeat(BOOK_TITLE_MAX_LENGTH + 1);
    const OVER_CAP_AUTHOR = "長".repeat(BOOK_AUTHOR_MAX_LENGTH + 1);
    const SAVED_TITLE = "原本的書名";
    const CAP_WARNING = "[moo] books over the server's text-field caps";

    function capWarnings(): unknown[][] {
      return vi
        .mocked(console.warn)
        .mock.calls.filter((call) => call[0] === CAP_WARNING);
    }

    function overCapAuthor(bookId: string, title?: string): ScrapedBook {
      return { ...scrapedBook(bookId, title), author: OVER_CAP_AUTHOR };
    }

    it("leaves a new book with an over-cap title out of the PUT and uploads the rest", async () => {
      mockScrape([
        scrapedBook(BOOK_A),
        scrapedBook(NEW_ID, OVER_CAP_TITLE),
        scrapedBook(BOOK_B),
      ]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]));

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(server.puts).toHaveLength(1);
      expect(server.puts[0].body.books.map((b) => b.bookId)).toEqual([
        BOOK_A,
        BOOK_B,
      ]);
      expect(result.fieldCapSkippedCount).toBe(1);
      expect(result.fieldCapBlankedCount).toBe(0);
      expect(result.books.map((b) => b.bookId)).not.toContain(NEW_ID);
      expect(capWarnings()).toEqual([
        [CAP_WARNING, { skippedCount: 1, blankedCount: 0, keptStoredCount: 0 }],
      ]);
      expect(wroteLastSyncAt()).toBe(true);
    });

    it("never auto-shares a left-out book, even with 新書預設開放 on", async () => {
      mockScrape([
        scrapedBook(BOOK_A),
        scrapedBook(NEW_ID, OVER_CAP_TITLE),
        scrapedBook(BOOK_B),
      ]);
      const server = createFakeServer({
        ...storedRecord([savedBook(BOOK_A)]),
        newBookDefaultShared: BoolFlag.TRUE,
      });

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      const body = server.puts[0].body;
      expect(body.books.map((b) => b.bookId)).toEqual([BOOK_A, BOOK_B]);
      // Positive companion: the genuinely new book that fits IS auto-shared.
      expect(isSharedOf(body.books, BOOK_B)).toBe(BoolFlag.TRUE);
      expect(result.autoSharedCount).toBe(1);
      expect(result.fieldCapSkippedCount).toBe(1);
    });

    it("uploads a new book with an over-cap author, its author blank, and counts it", async () => {
      const blanked = { ...overCapAuthor(NEW_ID), category: "小說" };
      mockScrape([scrapedBook(BOOK_A), blanked]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]));

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      const body = server.puts[0].body.books;
      expect(body.find((b) => b.bookId === NEW_ID)).toEqual({
        bookId: NEW_ID,
        title: blanked.title,
        author: "",
        isbn: "",
        coverUrl: "",
        readmooUrl: blanked.readmooUrl,
        category: "小說",
        isShared: BoolFlag.FALSE,
        isArchived: BoolFlag.FALSE,
      });
      expect(JSON.stringify(server.puts[0].body)).not.toContain(
        OVER_CAP_AUTHOR,
      );
      expect(result.fieldCapBlankedCount).toBe(1);
      expect(result.fieldCapSkippedCount).toBe(0);
      expect(result.books.map((b) => b.bookId)).toContain(NEW_ID);
      expect(capWarnings()).toEqual([
        [CAP_WARNING, { skippedCount: 0, blankedCount: 1, keptStoredCount: 0 }],
      ]);
    });

    it("auto-shares a blanked new book with 新書預設開放 on, like any new book", async () => {
      mockScrape([scrapedBook(BOOK_A), overCapAuthor(NEW_ID)]);
      const server = createFakeServer({
        ...storedRecord([savedBook(BOOK_A)]),
        newBookDefaultShared: BoolFlag.TRUE,
      });

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      const body = server.puts[0].body.books;
      expect(body.find((b) => b.bookId === NEW_ID)).toMatchObject({
        author: "",
        isShared: BoolFlag.TRUE,
      });
      expect(isSharedOf(body, BOOK_A)).toBe(BoolFlag.FALSE);
      expect(result.autoSharedCount).toBe(1);
      expect(result.fieldCapBlankedCount).toBe(1);
    });

    it("uploads a saved book with its share flag and the placeholder for its changed title when the scraped title is over the cap", async () => {
      mockScrape([
        { ...scrapedBook(BOOK_A, OVER_CAP_TITLE), author: "新作者" },
        scrapedBook(BOOK_B),
      ]);
      const server = createFakeServer(
        storedRecord([
          savedBook(BOOK_A, BoolFlag.TRUE, SAVED_TITLE),
          savedBook(BOOK_B),
        ]),
      );

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      const uploaded = server.puts[0].body.books.find(
        (b) => b.bookId === BOOK_A,
      );
      expect(uploaded).toMatchObject({
        title: OVER_CAP_TITLE_PLACEHOLDER,
        author: "新作者",
        isShared: BoolFlag.TRUE,
      });
      expect(result.fieldCapSkippedCount).toBe(0);
      expect(result.fieldCapBlankedCount).toBe(0);
      expect(result.removedBookCount).toBe(0);
      expect(capWarnings()).toEqual([
        [CAP_WARNING, { skippedCount: 0, blankedCount: 0, keptStoredCount: 1 }],
      ]);
    });

    it("reports no left-out or blanked books and logs no cap warning when every book fits", async () => {
      mockScrape([scrapedBook(BOOK_A), scrapedBook(BOOK_B)]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]));

      const result = await runSync(server.client);

      expect(result.success).toBe(true);
      expect(result.fieldCapSkippedCount).toBe(0);
      expect(result.fieldCapBlankedCount).toBe(0);
      expect(capWarnings()).toEqual([]);
      // Positive companion: the upload did happen, so the absence is not vacuous.
      expect(server.puts).toHaveLength(1);
    });

    it.each([
      {
        name: "the re-read now holds the previously new book, so the landed attempt keeps it",
        firstServer: [savedBook(BOOK_A)],
        racingServer: [
          savedBook(BOOK_A),
          savedBook(NEW_ID, BoolFlag.TRUE, SAVED_TITLE),
        ],
        firstPutIds: [BOOK_A],
        landedIds: [BOOK_A, NEW_ID],
        landedNew: {
          title: OVER_CAP_TITLE_PLACEHOLDER,
          isShared: BoolFlag.TRUE,
        },
        fieldCapSkippedCount: 0,
      },
      {
        name: "the re-read no longer holds the saved book, so the landed attempt leaves it out",
        firstServer: [
          savedBook(BOOK_A),
          savedBook(NEW_ID, BoolFlag.TRUE, SAVED_TITLE),
        ],
        racingServer: [savedBook(BOOK_A)],
        firstPutIds: [BOOK_A, NEW_ID],
        landedIds: [BOOK_A],
        landedNew: undefined,
        fieldCapSkippedCount: 1,
      },
    ])(
      "fits each attempt to its own read after a conflict: $name",
      async ({
        firstServer,
        racingServer,
        firstPutIds,
        landedIds,
        landedNew,
        fieldCapSkippedCount,
      }) => {
        mockScrape([scrapedBook(BOOK_A), scrapedBook(NEW_ID, OVER_CAP_TITLE)]);
        const server = createFakeServer(storedRecord(firstServer), {
          beforePut: (index, state) => {
            if (index === 0) state.stored = storedRecord(racingServer, "race");
          },
        });

        const result = await runSync(server.client, false);

        expect(result.success).toBe(true);
        expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
        expect(server.puts[0].body.books.map((b) => b.bookId)).toEqual(
          firstPutIds,
        );
        const landed = server.puts[1].body.books;
        expect(landed.map((b) => b.bookId)).toEqual(landedIds);
        const kept = landed.find((b) => b.bookId === NEW_ID);
        expect(kept && { title: kept.title, isShared: kept.isShared }).toEqual(
          landedNew,
        );
        expect(result.fieldCapSkippedCount).toBe(fieldCapSkippedCount);
        // A kept book never carries the over-cap scraped title.
        expect(landed.map((b) => b.title)).not.toContain(OVER_CAP_TITLE);
      },
    );

    it("reports the blanked count of the landed attempt after a conflict", async () => {
      mockScrape([scrapedBook(BOOK_A), overCapAuthor(NEW_ID)]);
      const server = createFakeServer(storedRecord([savedBook(BOOK_A)]), {
        // Another device uploaded NEW (with a short author) between this sync's read and its PUT.
        beforePut: (index, state) => {
          if (index !== 0) return;
          state.stored = storedRecord(
            [savedBook(BOOK_A), savedBook(NEW_ID)],
            "race",
          );
        },
      });

      const result = await runSync(server.client, false);

      expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
      expect(
        server.puts[0].body.books.find((b) => b.bookId === NEW_ID)?.author,
      ).toBe("");
      // The re-read holds NEW, so the landed attempt sends its stored author instead.
      expect(
        server.puts[1].body.books.find((b) => b.bookId === NEW_ID)?.author,
      ).toBe("作者");
      expect(result.fieldCapBlankedCount).toBe(0);
    });

    // See the header → "Same-title books".
    describe("same-title steps", () => {
      const THIRD_ID = "210000000000004";
      const LEGACY_ID = "14563038";
      const SAME_TITLE = "同名書";
      const STORED_TITLE = "原書名";
      const rows = (books: BookEntry[]) =>
        books.map((b) => [b.bookId, b.title, b.isShared]);

      it.each([BoolFlag.FALSE, BoolFlag.TRUE])(
        "pairs a saved book (isShared %s) with its new-id copy whose author is blanked",
        async (isShared) => {
          // OLD is gone from Readmoo's library; its same-title NEW copy has an over-cap author.
          mockScrape(
            [scrapedBook(KEPT_ID), overCapAuthor(NEW_ID, RENAMED_TITLE)],
            new Set([KEPT_ID, NEW_ID]),
          );
          const server = createFakeServer(
            storedRecord([
              savedBook(KEPT_ID),
              savedBook(OLD_ID, isShared, RENAMED_TITLE),
            ]),
          );

          const result = await runSync(server.client);

          expect(result.success).toBe(true);
          expect(result.renamedBooks).toEqual([
            { oldId: OLD_ID, newId: NEW_ID },
          ]);
          expect(result.removedBookCount).toBe(0);
          expect(result.fieldCapSkippedCount).toBe(0);
          expect(result.fieldCapBlankedCount).toBe(1);
          const body = server.puts[0].body.books;
          expect(body.map((b) => b.bookId)).toEqual([KEPT_ID, NEW_ID]);
          expect(body[1]).toMatchObject({ author: "", isShared });
        },
      );

      it("pairs the old book with its new-id copy when that copy fits (contrast)", async () => {
        mockScrape(
          [scrapedBook(KEPT_ID), scrapedBook(NEW_ID, RENAMED_TITLE)],
          new Set([KEPT_ID, NEW_ID]),
        );
        const server = createFakeServer(
          storedRecord([
            savedBook(KEPT_ID),
            savedBook(OLD_ID, BoolFlag.FALSE, RENAMED_TITLE),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
        expect(result.removedBookCount).toBe(0);
        expect(server.puts[0].body.books.map((b) => b.bookId)).toEqual([
          KEPT_ID,
          NEW_ID,
        ]);
      });

      it.each([
        {
          name: "a third, blanked copy makes two same-title new books: no rename, old book kept",
          withThird: true,
          renamed: [],
          ids: [KEPT_ID, NEW_ID, THIRD_ID, BOOK_B, OLD_ID],
          newShared: BoolFlag.FALSE,
          oldShared: BoolFlag.TRUE,
          blanked: 1,
        },
        {
          name: "without the third copy the rename pairs and carries the share (contrast)",
          withThird: false,
          renamed: [{ oldId: OLD_ID, newId: NEW_ID }],
          ids: [KEPT_ID, NEW_ID, BOOK_B],
          newShared: BoolFlag.TRUE,
          oldShared: undefined,
          blanked: 0,
        },
      ])(
        "$name",
        async ({ withThird, renamed, ids, newShared, oldShared, blanked }) => {
          mockScrape([
            scrapedBook(KEPT_ID),
            scrapedBook(NEW_ID, RENAMED_TITLE),
            ...(withThird ? [overCapAuthor(THIRD_ID, RENAMED_TITLE)] : []),
            scrapedBook(BOOK_B),
          ]);
          const server = createFakeServer({
            ...storedRecord([
              savedBook(KEPT_ID),
              savedBook(OLD_ID, BoolFlag.TRUE, RENAMED_TITLE),
            ]),
            newBookDefaultShared: BoolFlag.TRUE,
          });

          const result = await runSync(server.client);

          expect(result.success).toBe(true);
          expect(result.renamedBooks).toEqual(renamed);
          expect(result.fieldCapSkippedCount).toBe(0);
          expect(result.fieldCapBlankedCount).toBe(blanked);
          const body = server.puts[0].body.books;
          expect(body.map((b) => b.bookId)).toEqual(ids);
          expect(isSharedOf(body, NEW_ID)).toBe(newShared);
          expect(isSharedOf(body, OLD_ID)).toBe(oldShared);
          if (withThird) {
            // Titled like the saved OLD the scrape missed: an unpaired id change, never auto-shared.
            expect(body.find((b) => b.bookId === THIRD_ID)).toMatchObject({
              author: "",
              isShared: BoolFlag.FALSE,
            });
          }
          // Positive companion: the genuinely new book IS auto-shared either way.
          expect(isSharedOf(body, BOOK_B)).toBe(BoolFlag.TRUE);
          expect(result.autoSharedCount).toBe(1);
        },
      );

      it.each([
        {
          name: "keeps a shared legacy entry unresolved next to two real twins, one of them blanked",
          withBlanked: true,
          ids: [KEPT_ID, NEW_ID, LEGACY_ID],
          realShared: BoolFlag.FALSE,
          legacyShared: BoolFlag.TRUE,
        },
        {
          name: "resolves the legacy entry onto its lone real twin (contrast)",
          withBlanked: false,
          ids: [KEPT_ID],
          realShared: BoolFlag.TRUE,
          legacyShared: undefined,
        },
      ])("$name", async ({ withBlanked, ids, realShared, legacyShared }) => {
        mockScrape([
          scrapedBook(KEPT_ID, RENAMED_TITLE),
          ...(withBlanked ? [overCapAuthor(NEW_ID, RENAMED_TITLE)] : []),
        ]);
        const server = createFakeServer(
          storedRecord([
            savedBook(KEPT_ID, BoolFlag.FALSE, RENAMED_TITLE),
            savedBook(LEGACY_ID, BoolFlag.TRUE, RENAMED_TITLE),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        const body = server.puts[0].body.books;
        expect(body.map((b) => b.bookId)).toEqual(ids);
        expect(isSharedOf(body, KEPT_ID)).toBe(realShared);
        expect(isSharedOf(body, NEW_ID)).toBe(
          withBlanked ? BoolFlag.FALSE : undefined,
        );
        expect(isSharedOf(body, LEGACY_ID)).toBe(legacyShared);
        // The Personal Shelf load (usePersonalBooks.ts) runs the same rule on the saved list.
        expect(dropResolvedLegacyBooks(body)).toBe(body);
      });

      it.each([
        {
          name: "uploads both new twins of a shared legacy entry, one blanked, so it stays unresolved on reload",
          withBlanked: true,
          uploaded: [
            [NEW_ID, RENAMED_TITLE, BoolFlag.FALSE],
            [THIRD_ID, RENAMED_TITLE, BoolFlag.FALSE],
            [LEGACY_ID, RENAMED_TITLE, BoolFlag.TRUE],
          ],
        },
        {
          name: "uploads a lone new twin and resolves the legacy entry onto it (contrast, pre-existing #234 behaviour)",
          withBlanked: false,
          uploaded: [[NEW_ID, RENAMED_TITLE, BoolFlag.TRUE]],
        },
      ])("$name", async ({ withBlanked, uploaded }) => {
        mockScrape([
          scrapedBook(NEW_ID, RENAMED_TITLE),
          ...(withBlanked ? [overCapAuthor(THIRD_ID, RENAMED_TITLE)] : []),
        ]);
        const server = createFakeServer(
          storedRecord([savedBook(LEGACY_ID, BoolFlag.TRUE, RENAMED_TITLE)]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        const body = server.puts[0].body.books;
        expect(rows(body)).toEqual(uploaded);
        expect(result.fieldCapSkippedCount).toBe(0);
        expect(result.fieldCapBlankedCount).toBe(withBlanked ? 1 : 0);
        // The Personal Shelf load runs the same rule on the uploaded list.
        expect(dropResolvedLegacyBooks(body)).toBe(body);
      });

      it.each([
        {
          name: "uploads a saved book renamed to a blanked book's title with its new title, so the reload promotes nothing",
          withBlanked: true,
          uploaded: [
            [BOOK_A, SAME_TITLE, BoolFlag.FALSE],
            [BOOK_B, SAME_TITLE, BoolFlag.FALSE],
            [LEGACY_ID, SAME_TITLE, BoolFlag.TRUE],
          ],
        },
        {
          name: "without the blanked book the rename uploads and the legacy share moves onto it (contrast, pre-existing #234 behaviour)",
          withBlanked: false,
          uploaded: [[BOOK_A, SAME_TITLE, BoolFlag.TRUE]],
        },
      ])("$name", async ({ withBlanked, uploaded }) => {
        mockScrape([
          scrapedBook(BOOK_A, SAME_TITLE),
          ...(withBlanked ? [overCapAuthor(BOOK_B, SAME_TITLE)] : []),
        ]);
        const server = createFakeServer(
          storedRecord([
            savedBook(LEGACY_ID, BoolFlag.TRUE, SAME_TITLE),
            savedBook(BOOK_A, BoolFlag.FALSE, STORED_TITLE),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts).toHaveLength(1);
        const body = server.puts[0].body.books;
        expect(rows(body)).toEqual(uploaded);
        expect(result.fieldCapBlankedCount).toBe(withBlanked ? 1 : 0);
        // The Personal Shelf load (usePersonalBooks.ts) runs this on the saved list.
        expect(rows(dropResolvedLegacyBooks(body))).toEqual(uploaded);
      });

      it("uploads a saved book renamed away from a blanked book's title with its new title, so the reload promotes nothing", async () => {
        mockScrape([
          scrapedBook(BOOK_A, "新書名"),
          scrapedBook(THIRD_ID, SAME_TITLE),
          overCapAuthor(BOOK_B, SAME_TITLE),
        ]);
        const server = createFakeServer(
          storedRecord([
            savedBook(LEGACY_ID, BoolFlag.TRUE, SAME_TITLE),
            savedBook(BOOK_A, BoolFlag.FALSE, SAME_TITLE),
            savedBook(THIRD_ID, BoolFlag.FALSE, SAME_TITLE),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts).toHaveLength(1);
        const body = server.puts[0].body.books;
        const expected = [
          [BOOK_A, "新書名", BoolFlag.FALSE],
          [THIRD_ID, SAME_TITLE, BoolFlag.FALSE],
          [BOOK_B, SAME_TITLE, BoolFlag.FALSE],
          [LEGACY_ID, SAME_TITLE, BoolFlag.TRUE],
        ];
        expect(rows(body)).toEqual(expected);
        expect(result.fieldCapBlankedCount).toBe(1);
        // The Personal Shelf load (usePersonalBooks.ts) runs this on the saved list.
        expect(rows(dropResolvedLegacyBooks(body))).toEqual(expected);
      });

      it("uploads two saved books renamed apart and a blanked same-title new book, leaving the legacy entry alone", async () => {
        mockScrape([
          scrapedBook(BOOK_A, SAME_TITLE),
          scrapedBook(THIRD_ID, "另一書名"),
          overCapAuthor(BOOK_B, SAME_TITLE),
        ]);
        const server = createFakeServer(
          storedRecord([
            savedBook(LEGACY_ID, BoolFlag.TRUE, STORED_TITLE),
            savedBook(BOOK_A, BoolFlag.FALSE, STORED_TITLE),
            savedBook(THIRD_ID, BoolFlag.FALSE, STORED_TITLE),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts).toHaveLength(1);
        const body = server.puts[0].body.books;
        expect(rows(body)).toEqual([
          [BOOK_A, SAME_TITLE, BoolFlag.FALSE],
          [THIRD_ID, "另一書名", BoolFlag.FALSE],
          [BOOK_B, SAME_TITLE, BoolFlag.FALSE],
          [LEGACY_ID, STORED_TITLE, BoolFlag.TRUE],
        ]);
        expect(body.find((b) => b.bookId === BOOK_B)?.author).toBe("");
        expect(result.fieldCapBlankedCount).toBe(1);
        // The Personal Shelf load (usePersonalBooks.ts) runs this on the saved list.
        expect(dropResolvedLegacyBooks(body)).toBe(body);
      });

      // Mutation: with a 200-unit cut BOOK_A was sent titled exactly T and took the legacy share flag.
      it("uploads a saved book renamed to an over-cap title with the placeholder, never a cut equal to a legacy entry's 200-unit title", async () => {
        const legacyTitle = "a".repeat(BOOK_TITLE_MAX_LENGTH);
        mockScrape([scrapedBook(BOOK_A, `${legacyTitle}suffix`)]);
        const server = createFakeServer(
          storedRecord([
            savedBook(LEGACY_ID, BoolFlag.TRUE, legacyTitle),
            savedBook(BOOK_A, BoolFlag.FALSE, "Original"),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts).toHaveLength(1);
        const body = server.puts[0].body.books;
        expect(rows(body)).toEqual([
          [BOOK_A, OVER_CAP_TITLE_PLACEHOLDER, BoolFlag.FALSE],
          [LEGACY_ID, legacyTitle, BoolFlag.TRUE],
        ]);
        expect(result.fieldCapSkippedCount).toBe(0);
        // The Personal Shelf load (usePersonalBooks.ts) runs this on the saved list.
        expect(dropResolvedLegacyBooks(body)).toBe(body);
      });

      // See the header → "A left-out title still counts": a title stored before the caps existed.
      it.each([BoolFlag.FALSE, BoolFlag.TRUE])(
        "never prunes a saved book (isShared %s) with a pre-cap title whose new-id copy was left out",
        async (isShared) => {
          mockScrape(
            [scrapedBook(KEPT_ID), scrapedBook(NEW_ID, OVER_CAP_TITLE)],
            new Set([KEPT_ID, NEW_ID]),
          );
          const server = createFakeServer(
            storedRecord([
              savedBook(KEPT_ID),
              savedBook(OLD_ID, isShared, OVER_CAP_TITLE),
            ]),
          );

          const result = await runSync(server.client);

          expect(result.success).toBe(true);
          expect(result.fieldCapSkippedCount).toBe(1);
          expect(result.removedBookCount).toBe(0);
          expect(result.removedBooks).toEqual([]);
          expect(result.renamedBooks).toEqual([]);
          const body = server.puts[0].body.books;
          expect(body.map((b) => b.bookId)).toEqual([KEPT_ID, OLD_ID]);
          expect(isSharedOf(body, OLD_ID)).toBe(isShared);
        },
      );

      it.each([
        {
          name: "keeps a shared pre-cap legacy entry unresolved while its same-title new copy was left out",
          withSkipped: true,
          ids: [KEPT_ID, LEGACY_ID],
          realShared: BoolFlag.FALSE,
          legacyShared: BoolFlag.TRUE,
        },
        {
          name: "no longer resolves a pre-cap legacy entry onto its real twin even without a left-out copy (the accepted cost)",
          withSkipped: false,
          ids: [KEPT_ID, LEGACY_ID],
          realShared: BoolFlag.FALSE,
          legacyShared: BoolFlag.TRUE,
        },
      ])("$name", async ({ withSkipped, ids, realShared, legacyShared }) => {
        mockScrape([
          scrapedBook(KEPT_ID, OVER_CAP_TITLE),
          ...(withSkipped ? [scrapedBook(NEW_ID, OVER_CAP_TITLE)] : []),
        ]);
        const server = createFakeServer(
          storedRecord([
            savedBook(KEPT_ID, BoolFlag.FALSE, OVER_CAP_TITLE),
            savedBook(LEGACY_ID, BoolFlag.TRUE, OVER_CAP_TITLE),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        const body = server.puts[0].body.books;
        expect(body.map((b) => b.bookId)).toEqual(ids);
        expect(isSharedOf(body, KEPT_ID)).toBe(realShared);
        expect(isSharedOf(body, LEGACY_ID)).toBe(legacyShared);
        expect(body.find((b) => b.bookId === KEPT_ID)?.title).toBe(
          OVER_CAP_TITLE_PLACEHOLDER,
        );
        expect(result.fieldCapSkippedCount).toBe(withSkipped ? 1 : 0);
        expect(dropResolvedLegacyBooks(body)).toBe(body);
      });

      // Before the placeholder rule A kept T, and the Personal Shelf load resolved L onto A.
      it("keeps a shared pre-cap legacy entry unresolved at load when one same-title twin is renamed and a new one left out", async () => {
        const preCapTitle = "a".repeat(BOOK_TITLE_MAX_LENGTH + 1);
        mockScrape([
          scrapedBook(BOOK_A, preCapTitle),
          scrapedBook(THIRD_ID, "短書名"),
          scrapedBook(BOOK_B, preCapTitle),
        ]);
        const server = createFakeServer(
          storedRecord([
            savedBook(BOOK_A, BoolFlag.FALSE, preCapTitle),
            savedBook(THIRD_ID, BoolFlag.FALSE, preCapTitle),
            savedBook(LEGACY_ID, BoolFlag.TRUE, preCapTitle),
          ]),
        );

        const result = await runSync(server.client);

        expect(result.success).toBe(true);
        expect(server.puts).toHaveLength(1);
        const body = server.puts[0].body.books;
        expect(rows(body)).toEqual([
          [BOOK_A, OVER_CAP_TITLE_PLACEHOLDER, BoolFlag.FALSE],
          [THIRD_ID, "短書名", BoolFlag.FALSE],
          [LEGACY_ID, preCapTitle, BoolFlag.TRUE],
        ]);
        expect(result.fieldCapSkippedCount).toBe(1);
        // The Personal Shelf load (usePersonalBooks.ts) runs this on the saved list.
        expect(dropResolvedLegacyBooks(body)).toBe(body);
        // Second guard: even had A been sent titled T, an over-cap legacy title never resolves
        // (`legacyTitleCanResolve`), so L keeps its flag and A stays unshared.
        const withStoredTitle = body.map((b) =>
          b.bookId === BOOK_A ? { ...b, title: preCapTitle } : b,
        );
        expect(dropResolvedLegacyBooks(withStoredTitle)).toBe(withStoredTitle);
        expect(rows(withStoredTitle)).toEqual([
          [BOOK_A, preCapTitle, BoolFlag.FALSE],
          [THIRD_ID, "短書名", BoolFlag.FALSE],
          [LEGACY_ID, preCapTitle, BoolFlag.TRUE],
        ]);
      });

      // Before the over-cap legacy guard, L resolved onto R (its lone twin still storing T) at sync time.
      it.each([
        { reason: "archived while 同步封存書籍 is off", archived: true },
        { reason: "Readmoo's library ids unknown", archived: false },
      ])(
        "never shares an unscraped saved book still storing a pre-cap title when its scraped twin is sent as the placeholder ($reason)",
        async ({ archived }) => {
          const preCapTitle = "a".repeat(BOOK_TITLE_MAX_LENGTH + 1);
          mockScrape(
            [scrapedBook(BOOK_A, preCapTitle)],
            archived ? new Set([BOOK_A]) : null,
          );
          const unscraped = {
            ...savedBook(BOOK_B, BoolFlag.FALSE, preCapTitle),
            isArchived: archived ? BoolFlag.TRUE : BoolFlag.FALSE,
          };
          const server = createFakeServer(
            storedRecord([
              savedBook(LEGACY_ID, BoolFlag.TRUE, preCapTitle),
              savedBook(BOOK_A, BoolFlag.FALSE, preCapTitle),
              unscraped,
            ]),
          );

          const result = await runSync(server.client);

          expect(result.success).toBe(true);
          expect(server.puts).toHaveLength(1);
          const body = server.puts[0].body.books;
          expect(rows(body)).toEqual([
            [BOOK_A, OVER_CAP_TITLE_PLACEHOLDER, BoolFlag.FALSE],
            [LEGACY_ID, preCapTitle, BoolFlag.TRUE],
            [BOOK_B, preCapTitle, BoolFlag.FALSE],
          ]);
          expect(result.removedBookCount).toBe(0);
          // The Personal Shelf load (usePersonalBooks.ts) runs this on the saved list.
          expect(dropResolvedLegacyBooks(body)).toBe(body);
        },
      );
    });
  });
});
