import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePersonalBooks } from "@/dialog/usePersonalBooks";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";
import { PERSONAL_BOOKS_CACHE_KEY } from "@/constants";
import { readOwnedCachedBooks } from "@/dialog/personalBooksCache";
import {
  BOOKS_CONFLICT_MESSAGE,
  BOOKS_SAVE_CONFLICT_MESSAGE,
} from "moo-family-bookshelf-shared/personal/saveErrors";
import { MAX_SAVE_PUT_ATTEMPTS } from "moo-family-bookshelf-shared/personal/fullPutConflict";

/**
 * #259 (P0 privacy): a personal-shelf Save that takes a full
 * `PUT /api/user/:id/books` sends EVERY book's flag. Untouched books used to
 * carry the flag the screen read at load, so a book another device un-shared
 * in the meantime was written back as SHARED. The PUT now carries the read
 * `lastUpdated` as `expectedLastUpdated`; on `409 BOOKS_CONFLICT` the save
 * re-reads, keeps the local flag of every dirty book, takes the re-read flag
 * for every other book, and PUTs again (at most 3 PUTs). After it lands the
 * screen, the Cancel baseline, the cache and the record stamp all follow the
 * list that was really sent (`dialog/useSavePersonalShelf.ts`).
 *
 * Driven through `usePersonalBooks` against a fake server that honours the
 * Worker contract (worker/src/routes/user.ts): the precondition is optional, a
 * mismatch writes nothing and answers 409, an accepted PUT answers
 * `{ data: record }` with a fresh server stamp. The full PUT is reached the
 * way the shelf reaches it in practice: a batch share of more than the
 * Worker's 1000-change PATCH cap. PWA mirror: pwa/tests/unit/hooks/usePersonalShelfSave.test.ts.
 */

const USER = "user-abc";
const L0 = "2026-09-30T10:00:00.000Z";
const L1 = "2026-09-30T10:00:05.000Z";
const bookIdOf = (n: number): string => `21${String(n).padStart(13, "0")}`;
const A = bookIdOf(1);
const B = bookIdOf(2);
/** More ids than one PATCH may carry (1000), so the batch save is a full PUT. */
const BATCH = Array.from({ length: 1001 }, (_, i) => bookIdOf(100 + i));
const N0 = BATCH[0];

const WORKER_CONFLICT_ERROR = {
  code: "BOOKS_CONFLICT",
  message: "Books record changed since it was read",
};

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

type StoredRecord = Record<string, unknown> & { books: BookEntry[] };
type WireBody = StoredRecord & { expectedLastUpdated?: string };

interface PutLog {
  body: WireBody;
  outcome: "ok" | "conflict";
}

interface FakeServerOptions {
  /** Runs as PUT #index arrives, before the precondition check. */
  beforePut?: (index: number, server: FakeServer) => void;
  /** PUT #index stays pending until `releasePut()`; it is judged on release. */
  holdPut?: number;
  /** Answer an accepted PUT with no usable `lastUpdated` (`{ ok: true }`). */
  stamplessPutAnswer?: boolean;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A GET for a user with no record: the wire carries `data: null`. */
const NO_RECORD = { data: null } as unknown as Awaited<
  ReturnType<ApiClient["getPersonalBooks"]>
>;

class FakeServer {
  stored: StoredRecord;
  readonly puts: PutLog[] = [];
  writes = 0;
  private putCalls = 0;
  private release: (() => void) | null = null;
  readonly client: ApiClient;

  constructor(
    books: BookEntry[],
    private readonly options: FakeServerOptions = {},
  ) {
    this.stored = {
      schemaVersion: 1,
      userId: USER,
      displayName: "小明",
      books: clone(books),
      lastUpdated: L0,
    };
    this.client = {
      getPersonalBooks: vi.fn(async () => ({ data: clone(this.stored) })),
      updatePersonalBooks: vi.fn((_u: string, data: unknown) =>
        this.put(clone(data) as WireBody),
      ),
      patchPersonalBooks: vi.fn(async () => ({ data: { ok: true } })),
    } as unknown as ApiClient;
  }

  /** Another device saves: `bookId` gets `isShared` and the record a new stamp. */
  otherDeviceSets(bookId: string, isShared: BoolFlag, stamp: string): void {
    this.stored = {
      ...this.stored,
      books: this.stored.books.map((b) =>
        b.bookId === bookId ? { ...b, isShared } : b,
      ),
      lastUpdated: stamp,
    };
  }

  /** Another device's sync moves a book to a new Readmoo id (#236), un-shared. */
  otherDeviceRenames(oldId: string, newId: string, stamp: string): void {
    this.stored = {
      ...this.stored,
      books: this.stored.books.map((b) =>
        b.bookId === oldId
          ? { ...b, bookId: newId, isShared: BoolFlag.FALSE }
          : b,
      ),
      lastUpdated: stamp,
    };
  }

  releasePut(): void {
    this.release?.();
  }

  flagOf(bookId: string): BoolFlag | undefined {
    return this.stored.books.find((b) => b.bookId === bookId)?.isShared;
  }

  private put(body: WireBody): Promise<unknown> {
    const index = this.putCalls;
    this.putCalls += 1;
    if (index !== this.options.holdPut)
      return Promise.resolve(this.judge(body));
    return new Promise((resolve) => {
      this.release = () => resolve(this.judge(body));
    });
  }

  private judge(body: WireBody): unknown {
    this.options.beforePut?.(this.puts.length, this);
    const expected = body.expectedLastUpdated;
    if (
      typeof expected === "string" &&
      expected !== "" &&
      this.stored.lastUpdated !== expected
    ) {
      this.puts.push({ body, outcome: "conflict" });
      return { error: WORKER_CONFLICT_ERROR };
    }
    const record = { ...body };
    delete record.expectedLastUpdated;
    this.writes += 1;
    this.stored = { ...record, lastUpdated: `server-write-${this.writes}` };
    this.puts.push({ body, outcome: "ok" });
    return this.options.stamplessPutAnswer
      ? { data: { ok: true } }
      : { data: clone(this.stored) };
  }
}

function serverShelf(): BookEntry[] {
  return [
    makeBook(A, BoolFlag.TRUE),
    makeBook(B, BoolFlag.TRUE),
    ...BATCH.map((id) => makeBook(id)),
  ];
}

async function renderShelf(server: FakeServer) {
  const hook = renderHook(() =>
    usePersonalBooks({
      userId: USER,
      apiClient: server.client,
      lastSyncBooks: [],
      displayName: "小明",
    }),
  );
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}

type Shelf = Awaited<ReturnType<typeof renderShelf>>["result"];

/** PersonalShelf's batch action: set every BATCH book's flag, mark them all dirty. */
function batchSet(result: Shelf, isShared: BoolFlag): void {
  const ids = new Set(BATCH);
  act(() => {
    result.current.setBooks((prev) =>
      prev.map((b) => (ids.has(b.bookId) ? { ...b, isShared } : b)),
    );
    result.current.markManyDirty(ids);
  });
}

async function save(result: Shelf): Promise<void> {
  await act(async () => {
    await result.current.handleSave();
  });
}

const flagOf = (books: readonly BookEntry[] | undefined, id: string) =>
  books?.find((b) => b.bookId === id)?.isShared;

/** The raw string of the LAST personal-books cache write. */
function lastCacheRaw(): string | undefined {
  const writes = vi
    .mocked(chrome.storage.local.set)
    .mock.calls.map(([items]) => items as Record<string, unknown>)
    .filter((items) => items !== null && PERSONAL_BOOKS_CACHE_KEY in items);
  return writes.at(-1)?.[PERSONAL_BOOKS_CACHE_KEY] as string | undefined;
}

/** The books of the LAST cache write (the cache is `{ userId, books }`, #272). */
function lastCachedBooks(): BookEntry[] | undefined {
  const raw = lastCacheRaw();
  return raw === undefined
    ? undefined
    : (JSON.parse(raw) as { books: BookEntry[] }).books;
}

describe("useSavePersonalShelf (via usePersonalBooks) — full-PUT save over a list changed elsewhere (#259)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("never writes back a share another device removed, and lands the rebased list", async () => {
    const server = new FakeServer(serverShelf());
    const { result } = await renderShelf(server);
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.TRUE);

    // Another device un-shares A after this screen's read.
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    expect(server.client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
    expect(server.puts[0].body.expectedLastUpdated).toBe(L0);
    expect(server.puts[1].body.expectedLastUpdated).toBe(L1);
    const landed = server.puts[1].body.books;
    // The landed PUT carries A un-shared; the dirty books keep the local share.
    expect(flagOf(landed, A)).toBe(BoolFlag.FALSE);
    expect(flagOf(landed, B)).toBe(BoolFlag.TRUE);
    expect(BATCH.every((id) => flagOf(landed, id) === BoolFlag.TRUE)).toBe(
      true,
    );
    expect(server.flagOf(A)).toBe(BoolFlag.FALSE);

    // Screen, Cancel baseline and cache all show A un-shared; nothing is unsaved.
    expect(result.current.status).toBe("saved");
    expect(result.current.errorMessage).toBe("");
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.FALSE);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.TRUE);
    expect(flagOf(result.current.originalBooks.current, A)).toBe(
      BoolFlag.FALSE,
    );
    expect(flagOf(lastCachedBooks(), A)).toBe(BoolFlag.FALSE);
    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);

    // Cancel now restores the saved list, A un-shared.
    act(() => {
      result.current.handleCancel();
    });
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.FALSE);
  });

  it("sends a book another device's sync moved to a new id as not shared, without adding the new id", async () => {
    const X_OLD = bookIdOf(7);
    const X_NEW = bookIdOf(8);
    const server = new FakeServer([
      makeBook(X_OLD, BoolFlag.TRUE),
      ...serverShelf(),
    ]);
    const { result } = await renderShelf(server);
    expect(flagOf(result.current.books, X_OLD)).toBe(BoolFlag.TRUE);

    // After this screen's read, another device replaces X_OLD with X_NEW.
    server.otherDeviceRenames(X_OLD, X_NEW, L1);
    batchSet(result, BoolFlag.TRUE);
    expect(result.current.dirtyBookIds.has(X_OLD)).toBe(false);
    await save(result);

    expect(server.client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
    const landed = server.puts[1].body.books;
    expect(flagOf(landed, X_OLD)).toBe(BoolFlag.FALSE);
    expect(landed.some((b) => b.bookId === X_NEW)).toBe(false);
    // Positive companions: the local set is sent whole, the batch shared.
    expect(landed.map((b) => b.bookId)).toEqual(
      result.current.books.map((b) => b.bookId),
    );
    expect(flagOf(landed, N0)).toBe(BoolFlag.TRUE);
    expect(server.flagOf(X_OLD)).toBe(BoolFlag.FALSE);

    // Screen, Cancel baseline and cache follow the sent list; nothing unsaved.
    expect(result.current.status).toBe("saved");
    expect(flagOf(result.current.books, X_OLD)).toBe(BoolFlag.FALSE);
    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.originalBooks.current).toEqual(landed);
    expect(lastCachedBooks()).toEqual(landed);
    // #272: the cache is tagged with the saving account, so only it may migrate it.
    expect(JSON.parse(lastCacheRaw()!)).toEqual({
      userId: USER,
      books: landed,
    });
    expect(readOwnedCachedBooks(lastCacheRaw()!, USER)).toEqual(landed);
    act(() => {
      result.current.handleCancel();
    });
    expect(flagOf(result.current.books, X_OLD)).toBe(BoolFlag.FALSE);
  });

  it("sends a single PUT with the read stamp when nothing changed elsewhere", async () => {
    const server = new FakeServer(serverShelf());
    const { result } = await renderShelf(server);

    batchSet(result, BoolFlag.TRUE);
    await save(result);

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0].body.expectedLastUpdated).toBe(L0);
    expect(server.puts[0].outcome).toBe("ok");
    expect(server.client.getPersonalBooks).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saved");
  });

  it("builds the next PUT on the stamp the landed PUT answered with", async () => {
    const server = new FakeServer(serverShelf());
    const { result } = await renderShelf(server);
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    batchSet(result, BoolFlag.TRUE);
    await save(result);
    expect(server.stored.lastUpdated).toBe("server-write-1");

    batchSet(result, BoolFlag.FALSE);
    await save(result);

    // No self-inflicted conflict: the next save already holds the new stamp.
    expect(server.puts[2].body.expectedLastUpdated).toBe("server-write-1");
    expect(server.puts[2].outcome).toBe("ok");
    expect(server.puts).toHaveLength(3);
    expect(flagOf(server.puts[2].body.books, A)).toBe(BoolFlag.FALSE);
  });

  it("keeps the re-read stamp when the PUT response carries no usable lastUpdated", async () => {
    const server = new FakeServer(serverShelf(), { stamplessPutAnswer: true });
    const { result } = await renderShelf(server);
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    batchSet(result, BoolFlag.FALSE);
    await save(result);

    // The newest stamp this screen knows is the re-read one.
    expect(server.puts[2].body.expectedLastUpdated).toBe(L1);
    expect(flagOf(server.puts.at(-1)?.body.books, A)).toBe(BoolFlag.FALSE);
    expect(result.current.status).toBe("saved");
  });

  it("gives up after 3 conflicted PUTs with the Save wording, keeping every unsaved change", async () => {
    let stamp = 0;
    const server = new FakeServer(serverShelf(), {
      // Another device writes again before every PUT arrives.
      beforePut: (_i, s) => {
        stamp += 1;
        s.otherDeviceSets(A, BoolFlag.FALSE, `elsewhere-${stamp}`);
      },
    });
    const { result } = await renderShelf(server);
    batchSet(result, BoolFlag.TRUE);
    vi.mocked(chrome.storage.local.set).mockClear();

    await save(result);

    expect(server.puts).toHaveLength(MAX_SAVE_PUT_ATTEMPTS);
    expect(server.puts.every((p) => p.outcome === "conflict")).toBe(true);
    // One load read plus a re-read after each of the first two conflicts.
    expect(server.client.getPersonalBooks).toHaveBeenCalledTimes(3);
    expect(server.writes).toBe(0);
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe(BOOKS_SAVE_CONFLICT_MESSAGE);
    expect(result.current.errorMessage).not.toBe(BOOKS_CONFLICT_MESSAGE);
    expect(result.current.dirtyBookIds.size).toBe(BATCH.length);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.TRUE);
    expect(lastCachedBooks()).toBeUndefined();
  });

  it("keeps a share change made while the rebased PUT is in flight, and keeps it unsaved", async () => {
    // PUT #1 (index 1) is the rebased retry; hold it open.
    const server = new FakeServer(serverShelf(), { holdPut: 1 });
    const { result } = await renderShelf(server);
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    batchSet(result, BoolFlag.TRUE);

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.handleSave();
    });
    await waitFor(() =>
      expect(server.client.updatePersonalBooks).toHaveBeenCalledTimes(2),
    );
    expect(result.current.status).toBe("saving");

    // Mid-save: un-share B (not part of the save) and revert one sent book.
    act(() => {
      result.current.handleToggle(B);
      result.current.handleToggle(N0);
    });
    await act(async () => {
      server.releasePut();
      await pending;
    });

    expect(result.current.status).toBe("saved");
    // The landed PUT sent B's server share and N0's share…
    const landed = server.puts[1].body.books;
    expect(flagOf(landed, B)).toBe(BoolFlag.TRUE);
    expect(flagOf(landed, N0)).toBe(BoolFlag.TRUE);
    // …the screen keeps both mid-save changes, and both stay unsaved.
    expect(flagOf(result.current.books, B)).toBe(BoolFlag.FALSE);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.FALSE);
    expect([...result.current.dirtyBookIds].sort()).toEqual([B, N0].sort());
    // Books untouched mid-save take the landed flags.
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.FALSE);
    expect(flagOf(result.current.originalBooks.current, B)).toBe(BoolFlag.TRUE);

    // The next save sends just the two pending changes.
    await save(result);
    expect(server.client.patchPersonalBooks).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(server.client.patchPersonalBooks).mock.calls[0][1],
    ).toEqual([
      { bookId: B, isShared: BoolFlag.FALSE },
      { bookId: N0, isShared: BoolFlag.FALSE },
    ]);
  });

  it("rebases the PUT a sync-dropped toggle forces, too", async () => {
    // Small shelf: A shared, B not; the user shares B and toggles X, which a
    // sync then drops — a dirty id that left the list sends the list whole.
    const X = bookIdOf(9);
    const server = new FakeServer([
      makeBook(A, BoolFlag.TRUE),
      makeBook(B),
      makeBook(X),
    ]);
    const { result, rerender } = renderHook(
      ({ lastSyncBooks }: { lastSyncBooks: BookEntry[] }) =>
        usePersonalBooks({
          userId: USER,
          apiClient: server.client,
          lastSyncBooks,
          displayName: "小明",
        }),
      { initialProps: { lastSyncBooks: [] as BookEntry[] } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.handleToggle(B);
      result.current.handleToggle(X);
    });
    await act(async () => {
      rerender({ lastSyncBooks: [makeBook(A, BoolFlag.TRUE), makeBook(B)] });
    });
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    await save(result);

    expect(server.client.patchPersonalBooks).not.toHaveBeenCalled();
    expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
    expect(
      server.puts[1].body.books.map((b) => [b.bookId, b.isShared]),
    ).toEqual([
      [A, BoolFlag.FALSE],
      [B, BoolFlag.TRUE],
    ]);
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.FALSE);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });

  it("reports the conflict and sends no second PUT when the re-read finds no record", async () => {
    const server = new FakeServer(serverShelf());
    const { result } = await renderShelf(server);
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    // The re-read after the conflict answers like a deleted record.
    vi.mocked(server.client.getPersonalBooks).mockResolvedValueOnce(NO_RECORD);
    batchSet(result, BoolFlag.TRUE);
    vi.mocked(chrome.storage.local.set).mockClear();

    await save(result);

    expect(server.client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(server.puts.map((p) => p.outcome)).toEqual(["conflict"]);
    expect(server.client.getPersonalBooks).toHaveBeenCalledTimes(2);
    expect(server.writes).toBe(0);
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe(BOOKS_SAVE_CONFLICT_MESSAGE);
    expect(result.current.dirtyBookIds.size).toBe(BATCH.length);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.TRUE);
    expect(lastCachedBooks()).toBeUndefined();
  });
});

/**
 * #259 fix cycle (C1 / S1): a sync result carries the `lastUpdated` its own PUT
 * stored, and applying it puts THAT stamp in the record the next full PUT
 * builds on. The screen then never holds a newer stamp over the sync's older
 * flags (C1), and a shelf that loaded no record gets a precondition (S1). A
 * result without a stamp (its PUT response carried no usable `lastUpdated`)
 * keeps whatever stamp was held.
 */
describe("usePersonalBooks — the stamp a sync result carries (#259)", () => {
  /** The stamp the sync's own PUT stored on the fake server. */
  const LS = "2026-09-30T10:00:03.000Z";

  interface SyncProps {
    lastSyncBooks: BookEntry[];
    lastSyncLastUpdated?: string;
  }

  async function renderSyncedShelf(server: FakeServer) {
    const hook = renderHook(
      ({ lastSyncBooks, lastSyncLastUpdated }: SyncProps) =>
        usePersonalBooks({
          userId: USER,
          apiClient: server.client,
          lastSyncBooks,
          lastSyncLastUpdated,
          displayName: "小明",
        }),
      { initialProps: { lastSyncBooks: [] } as SyncProps },
    );
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    return hook;
  }

  /** A sync's PUT lands: the server holds `books` under `stamp`. */
  function syncLands(server: FakeServer, books: BookEntry[], stamp: string) {
    server.stored = {
      ...server.stored,
      books: clone(books),
      lastUpdated: stamp,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("C1: a sync result applied after a later save sends the sync's stamp, so its stale share is never written back", async () => {
    const X = A;
    const server = new FakeServer(serverShelf());
    const { result, rerender } = await renderSyncedShelf(server);
    expect(flagOf(result.current.books, X)).toBe(BoolFlag.TRUE);

    // A sync started before the un-share lands its PUT first: X shared at L1.
    const syncList = serverShelf();
    syncLands(server, syncList, L1);
    // The user un-shares X and saves through the full PUT (batch of 1001).
    act(() => {
      result.current.handleToggle(X);
    });
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
    expect(server.puts[0].body.expectedLastUpdated).toBe(L0);
    expect(server.puts[1].body.expectedLastUpdated).toBe(L1);
    expect(flagOf(server.puts[1].body.books, X)).toBe(BoolFlag.FALSE);
    const L2 = server.stored.lastUpdated;
    expect(L2).toBe("server-write-1");
    expect(result.current.status).toBe("saved");

    // Only now does that sync's result reach the shelf: X shared, stamp L1.
    await act(async () => {
      rerender({ lastSyncBooks: clone(syncList), lastSyncLastUpdated: L1 });
    });
    expect(flagOf(result.current.books, X)).toBe(BoolFlag.TRUE);

    // Another full PUT that leaves X alone.
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    // It carries the sync's L1, not the save's L2: the server answers 409 …
    expect(server.puts[2].body.expectedLastUpdated).toBe(L1);
    expect(server.puts[2].body.expectedLastUpdated).not.toBe(L2);
    expect(server.puts[2].outcome).toBe("conflict");
    // … and the PUT that lands is rebased onto X un-shared.
    expect(server.puts[3].body.expectedLastUpdated).toBe(L2);
    expect(server.puts[3].outcome).toBe("ok");
    expect(server.puts).toHaveLength(4);
    expect(flagOf(server.puts[3].body.books, X)).toBe(BoolFlag.FALSE);
    expect(server.flagOf(X)).toBe(BoolFlag.FALSE);
    expect(
      server.puts
        .filter((p) => p.outcome === "ok")
        .map((p) => flagOf(p.body.books, X)),
    ).not.toContain(BoolFlag.TRUE);
    expect(flagOf(result.current.books, X)).toBe(BoolFlag.FALSE);
    expect(result.current.status).toBe("saved");
  });

  it("sends the stamp of a sync result applied before the save, in a single PUT", async () => {
    const server = new FakeServer(serverShelf());
    const { result, rerender } = await renderSyncedShelf(server);
    const syncList = serverShelf();
    syncLands(server, syncList, LS);

    await act(async () => {
      rerender({ lastSyncBooks: clone(syncList), lastSyncLastUpdated: LS });
    });
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    // No self-inflicted conflict against the sync's own write.
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0].body.expectedLastUpdated).toBe(LS);
    expect(server.puts[0].outcome).toBe("ok");
    expect(server.client.getPersonalBooks).toHaveBeenCalledTimes(1);
  });

  it("S1: a shelf that loaded no record sends the applied sync's stamp as precondition", async () => {
    const server = new FakeServer(serverShelf());
    vi.mocked(server.client.getPersonalBooks).mockResolvedValueOnce(NO_RECORD);
    const { result, rerender } = await renderSyncedShelf(server);
    expect(result.current.books).toEqual([]);
    // The first sync created the record.
    const syncList = serverShelf();
    syncLands(server, syncList, LS);

    await act(async () => {
      rerender({ lastSyncBooks: clone(syncList), lastSyncLastUpdated: LS });
    });
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0].body).toHaveProperty("expectedLastUpdated", LS);
    expect(server.puts[0].outcome).toBe("ok");
  });

  it("S1: the precondition makes a save over a newer record re-read instead of overwriting it", async () => {
    const server = new FakeServer(serverShelf());
    vi.mocked(server.client.getPersonalBooks).mockResolvedValueOnce(NO_RECORD);
    const { result, rerender } = await renderSyncedShelf(server);
    const syncList = serverShelf();
    syncLands(server, syncList, LS);
    await act(async () => {
      rerender({ lastSyncBooks: clone(syncList), lastSyncLastUpdated: LS });
    });

    // Another device un-shares A after the sync.
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    expect(server.puts.map((p) => p.outcome)).toEqual(["conflict", "ok"]);
    expect(server.puts[0].body.expectedLastUpdated).toBe(LS);
    expect(flagOf(server.puts[1].body.books, A)).toBe(BoolFlag.FALSE);
    expect(server.flagOf(A)).toBe(BoolFlag.FALSE);
  });

  it("keeps the held stamp when the sync result carries none", async () => {
    const server = new FakeServer(serverShelf());
    const { result, rerender } = await renderSyncedShelf(server);

    await act(async () => {
      rerender({ lastSyncBooks: serverShelf() });
    });
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0].body.expectedLastUpdated).toBe(L0);
    expect(server.puts[0].outcome).toBe("ok");
  });

  it("sends no precondition when neither the load nor the sync result has a stamp", async () => {
    const server = new FakeServer(serverShelf());
    vi.mocked(server.client.getPersonalBooks).mockResolvedValueOnce(NO_RECORD);
    const { result, rerender } = await renderSyncedShelf(server);

    await act(async () => {
      rerender({ lastSyncBooks: serverShelf() });
    });
    batchSet(result, BoolFlag.TRUE);
    await save(result);

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0].body).not.toHaveProperty("expectedLastUpdated");
    // Positive companion: this really is the batch PUT.
    expect(flagOf(server.puts[0].body.books, N0)).toBe(BoolFlag.TRUE);
    expect(server.puts[0].outcome).toBe("ok");
  });
});
