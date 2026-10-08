import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";
import {
  BOOKS_CONFLICT_MESSAGE,
  BOOKS_SAVE_CONFLICT_MESSAGE,
} from "moo-family-bookshelf-shared/personal/saveErrors";
import { MAX_SAVE_PUT_ATTEMPTS } from "moo-family-bookshelf-shared/personal/fullPutConflict";

/**
 * #259 (P0 privacy), PWA mirror of
 * extension/tests/unit/dialog/useSavePersonalShelf.test.ts. A personal-shelf
 * Save that takes a full `PUT /api/user/:id/books` sends EVERY book's flag;
 * untouched books used to carry the flag read at load, so a book another
 * device un-shared since then was written back as SHARED. The PUT now carries
 * the read `lastUpdated` as `expectedLastUpdated`; on `409 BOOKS_CONFLICT` the
 * save re-reads, keeps the local flag of every dirty book, takes the re-read
 * flag for every other book, and PUTs again (at most 3 PUTs). After it lands,
 * the Cancel baseline and the record snapshot hold the list really sent, and
 * the screen shows its flags for every book not unsaved right now
 * (`hooks/usePersonalShelfSave.ts`).
 *
 * Driven through `usePersonalShelfEditor` against a fake server that honours
 * the Worker contract (worker/src/routes/user.ts). The PWA reaches a full PUT
 * in practice through a batch share of more than the Worker's 1000-change
 * PATCH cap (its list only ever holds server-known books).
 */

// The save refreshes the aggregated family shelf through the FamilyData
// context; isolate the hook from it (same approach as PersonalShelfPage.test).
const mockRefreshBookshelf = vi.fn(async () => {});
vi.mock("@/hooks/useFamilyData", () => ({
  useFamilyData: () => ({ refreshBookshelf: mockRefreshBookshelf }),
}));

import { usePersonalShelfEditor } from "@/hooks/usePersonalShelfEditor";

const USER = "user-1";
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
  isArchived: BoolFlag.FALSE,
});

type StoredRecord = Record<string, unknown> & { books: BookEntry[] };
type WireBody = StoredRecord & { expectedLastUpdated?: string };

interface PutLog {
  body: WireBody;
  outcome: "ok" | "conflict";
}

interface FakeServerOptions {
  /** Runs as PUT #index is judged, before the precondition check. */
  beforePut?: (index: number, server: FakeServer) => void;
  /** PUT #index stays pending until `releasePut()`; it is judged on release. */
  holdPut?: number;
  /** Answer an accepted PUT with no usable `lastUpdated` (`{ ok: true }`). */
  stamplessPutAnswer?: boolean;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
  const hook = renderHook(() => usePersonalShelfEditor(USER, server.client));
  await waitFor(() => expect(hook.result.current.state).toBe("ready"));
  return hook;
}

type Shelf = Awaited<ReturnType<typeof renderShelf>>["result"];

/** The page's batch action: select every BATCH book, then share / hide them. */
function batchSet(result: Shelf, isShared: BoolFlag): void {
  act(() => {
    result.current.setSelectedIds(new Set(BATCH));
  });
  act(() => {
    if (isShared === BoolFlag.TRUE) result.current.handleBatchShare();
    else result.current.handleBatchHide();
  });
}

async function save(result: Shelf): Promise<void> {
  await act(async () => {
    await result.current.handleSave();
  });
}

const flagOf = (books: readonly BookEntry[] | undefined, id: string) =>
  books?.find((b) => b.bookId === id)?.isShared;

describe("usePersonalShelfSave (via usePersonalShelfEditor) — full-PUT save over a list changed elsewhere (#259)", () => {
  beforeEach(() => {
    mockRefreshBookshelf.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("never writes back a share another device removed, and lands the rebased list", async () => {
    const server = new FakeServer(serverShelf());
    const { result } = await renderShelf(server);
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.TRUE);

    // Another device un-shares A after this screen's read.
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    batchSet(result, BoolFlag.TRUE);
    expect(result.current.dirtyBookIds.size).toBe(BATCH.length);
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

    // The screen shows A un-shared and nothing is left unsaved.
    expect(result.current.state).toBe("saved");
    expect(result.current.errorMessage).toBe("");
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.FALSE);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.TRUE);
    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(mockRefreshBookshelf).toHaveBeenCalledTimes(1);

    // Cancel restores the saved baseline: A un-shared.
    act(() => {
      result.current.handleCancelChanges();
    });
    expect(flagOf(result.current.books, A)).toBe(BoolFlag.FALSE);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.TRUE);
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

    // The screen follows the sent list and nothing is left unsaved.
    expect(result.current.state).toBe("saved");
    expect(flagOf(result.current.books, X_OLD)).toBe(BoolFlag.FALSE);
    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.books).toEqual(landed);

    // Cancel restores the saved baseline: the sent list, X_OLD un-shared.
    act(() => {
      result.current.handleCancelChanges();
    });
    expect(result.current.books).toEqual(landed);
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
    expect(result.current.state).toBe("saved");
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
    expect(result.current.state).toBe("saved");
  });

  it("gives up after 3 conflicted PUTs with the Save wording, keeping every unsaved change", async () => {
    let stamp = 0;
    const server = new FakeServer(serverShelf(), {
      // Another device writes again before every PUT is judged.
      beforePut: (_i, s) => {
        stamp += 1;
        s.otherDeviceSets(A, BoolFlag.FALSE, `elsewhere-${stamp}`);
      },
    });
    const { result } = await renderShelf(server);
    batchSet(result, BoolFlag.TRUE);

    await save(result);

    expect(server.puts).toHaveLength(MAX_SAVE_PUT_ATTEMPTS);
    expect(server.puts.every((p) => p.outcome === "conflict")).toBe(true);
    // One load read plus a re-read after each of the first two conflicts.
    expect(server.client.getPersonalBooks).toHaveBeenCalledTimes(3);
    expect(server.writes).toBe(0);
    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toBe(BOOKS_SAVE_CONFLICT_MESSAGE);
    expect(result.current.errorMessage).not.toBe(BOOKS_CONFLICT_MESSAGE);
    expect(result.current.dirtyBookIds.size).toBe(BATCH.length);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.TRUE);
    expect(mockRefreshBookshelf).not.toHaveBeenCalled();
  });

  it("reports the conflict and sends no second PUT when the re-read finds no record", async () => {
    const server = new FakeServer(serverShelf());
    const { result } = await renderShelf(server);
    server.otherDeviceSets(A, BoolFlag.FALSE, L1);
    // The re-read after the conflict answers like a deleted record (the wire
    // carries `data: null`, which the PWA client type does not spell out).
    vi.mocked(server.client.getPersonalBooks).mockResolvedValueOnce({
      data: null,
    } as unknown as Awaited<ReturnType<ApiClient["getPersonalBooks"]>>);
    batchSet(result, BoolFlag.TRUE);

    await save(result);

    expect(server.client.updatePersonalBooks).toHaveBeenCalledTimes(1);
    expect(server.puts.map((p) => p.outcome)).toEqual(["conflict"]);
    expect(server.client.getPersonalBooks).toHaveBeenCalledTimes(2);
    expect(server.writes).toBe(0);
    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toBe(BOOKS_SAVE_CONFLICT_MESSAGE);
    expect(result.current.dirtyBookIds.size).toBe(BATCH.length);
    expect(flagOf(result.current.books, N0)).toBe(BoolFlag.TRUE);
    expect(mockRefreshBookshelf).not.toHaveBeenCalled();
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
    expect(result.current.state).toBe("saving");

    // Mid-save: un-share B (not part of the save) and revert one sent book.
    act(() => {
      result.current.handleToggle(B);
      result.current.handleToggle(N0);
    });
    await act(async () => {
      server.releasePut();
      await pending;
    });

    expect(result.current.state).toBe("saved");
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
});
