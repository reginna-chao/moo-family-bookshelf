import { describe, it, expect, vi } from "vitest";
import { uploadPersonalShelf } from "@/dialog/personalShelfUpload";
import {
  BoolFlag,
  PERSONAL_BOOKS_SCHEMA_VERSION,
  type ApiClient,
  type BookEntry,
} from "@/api/client";

/**
 * `dialog/personalShelfUpload.ts` (#259) — the network half of the Extension's
 * personal-shelf Save. A PATCH stays as it was; a full PUT goes through the
 * shared `putBooksRebasingOnConflict` and re-reads with the dialog's OWN load
 * rule (`loadSavedBooks` + `dropResolvedLegacyBooks`), so a rebase shows the
 * flags a fresh load of the shelf would show.
 *
 * The full-PUT path is reached here with a record that carries a stamp but no
 * `books` array: nothing is server-known, so `decideSaveStrategy` picks PUT.
 * The hook-level regression lives in `useSavePersonalShelf.test.ts`.
 */

const USER = "user-abc";
const A = "210000000000001";
const D = "210000000000002";
const L0 = "2026-09-30T10:00:00.000Z";
const L1 = "2026-09-30T10:00:05.000Z";
const CONFLICT = {
  error: {
    code: "BOOKS_CONFLICT",
    message: "Books record changed since it was read",
  },
};

const makeBook = (
  bookId: string,
  isShared: BoolFlag,
  title = `書-${bookId}`,
): BookEntry => ({
  bookId,
  title,
  author: "",
  isbn: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isShared,
});

function client(overrides: Partial<Record<keyof ApiClient, unknown>> = {}) {
  return {
    getPersonalBooks: vi.fn(),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    patchPersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    ...overrides,
  } as unknown as ApiClient;
}

const LOCAL = [makeBook(A, BoolFlag.TRUE), makeBook(D, BoolFlag.TRUE)];

describe("uploadPersonalShelf (Extension)", () => {
  it("PATCHes a server-known dirty book and reports the landed PATCH", async () => {
    const api = client();
    const raw = {
      books: [makeBook(A, BoolFlag.TRUE), makeBook(D, BoolFlag.FALSE)],
      lastUpdated: L0,
    };

    const result = await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "小明",
      books: LOCAL,
      dirtyBookIds: new Set([D]),
      raw,
    });

    expect(api.updatePersonalBooks).not.toHaveBeenCalled();
    expect(api.getPersonalBooks).not.toHaveBeenCalled();
    expect(api.patchPersonalBooks).toHaveBeenCalledWith(USER, [
      { bookId: D, isShared: BoolFlag.TRUE },
    ]);
    expect(result).toEqual({
      ok: true,
      landed: {
        usePut: false,
        books: LOCAL,
        sent: [{ bookId: D, isShared: BoolFlag.TRUE }],
        raw,
      },
    });
  });

  it("returns a PATCH error without retrying", async () => {
    const error = { code: "BOOM", message: "patch failed" };
    const api = client({
      patchPersonalBooks: vi.fn().mockResolvedValue({ error }),
    });

    const result = await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "",
      books: LOCAL,
      dirtyBookIds: new Set([D]),
      raw: { books: [makeBook(D, BoolFlag.FALSE)], lastUpdated: L0 },
    });

    expect(result).toEqual({ ok: false, error });
    expect(api.patchPersonalBooks).toHaveBeenCalledTimes(1);
  });

  it("sends a full PUT that keeps unknown record fields and carries the read stamp", async () => {
    const api = client({
      updatePersonalBooks: vi
        .fn()
        .mockResolvedValue({ data: { lastUpdated: L1 } }),
    });
    const raw = { lastUpdated: L0, futureField: "kept" };

    const result = await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "小明",
      books: LOCAL,
      dirtyBookIds: new Set([D]),
      raw,
    });

    expect(api.patchPersonalBooks).not.toHaveBeenCalled();
    const [userId, body] = vi.mocked(api.updatePersonalBooks).mock.calls[0];
    expect(userId).toBe(USER);
    expect(body).toMatchObject({
      futureField: "kept",
      schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
      userId: USER,
      displayName: "小明",
      books: LOCAL,
      expectedLastUpdated: L0,
    });
    // The client's own write time, never the precondition echoed back.
    expect(body.lastUpdated).not.toBe(L0);
    expect(result).toEqual({
      ok: true,
      landed: {
        usePut: true,
        books: LOCAL,
        sent: [
          { bookId: A, isShared: BoolFlag.TRUE },
          { bookId: D, isShared: BoolFlag.TRUE },
        ],
        raw: { ...raw, lastUpdated: L1 },
      },
    });
  });

  it("sends no precondition on the wire when there is no record", async () => {
    const api = client();

    await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "",
      books: LOCAL,
      dirtyBookIds: new Set([D]),
      raw: null,
    });

    const body = vi.mocked(api.updatePersonalBooks).mock.calls[0][1];
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty(
      "expectedLastUpdated",
    );
  });

  it("rebases onto the re-read and reports every flag the landed PUT sent", async () => {
    const reread = {
      schemaVersion: 1,
      books: [makeBook(A, BoolFlag.FALSE), makeBook(D, BoolFlag.FALSE)],
      lastUpdated: L1,
    };
    const api = client({
      getPersonalBooks: vi.fn().mockResolvedValue({ data: reread }),
      updatePersonalBooks: vi
        .fn()
        .mockResolvedValueOnce(CONFLICT)
        .mockResolvedValueOnce({ data: { ok: true } }),
    });

    const result = await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "",
      books: LOCAL,
      dirtyBookIds: new Set([D]),
      raw: { lastUpdated: L0 },
    });

    const calls = vi.mocked(api.updatePersonalBooks).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].expectedLastUpdated).toBe(L0);
    expect(calls[1][1].expectedLastUpdated).toBe(L1);
    const sentFlags = [
      { bookId: A, isShared: BoolFlag.FALSE },
      { bookId: D, isShared: BoolFlag.TRUE },
    ];
    expect(
      calls[1][1].books.map((b) => ({
        bookId: b.bookId,
        isShared: b.isShared,
      })),
    ).toEqual(sentFlags);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.landed.sent).toEqual(sentFlags);
    // A PUT response with no usable `lastUpdated`: the re-read stamp is the newest known.
    expect(result.landed.raw).toEqual(reread);
  });

  it("rebases a real id onto the share it inherits from a legacy twin, as a fresh load shows it", async () => {
    const LEGACY = "14563038";
    const real = makeBook(A, BoolFlag.FALSE, "三體");
    // The re-read holds the legacy short-id copy (shared) next to the real id.
    const reread = {
      books: [makeBook(LEGACY, BoolFlag.TRUE, "三體"), real],
      lastUpdated: L1,
    };
    const api = client({
      getPersonalBooks: vi.fn().mockResolvedValue({ data: reread }),
      updatePersonalBooks: vi
        .fn()
        .mockResolvedValueOnce(CONFLICT)
        .mockResolvedValueOnce({ data: { ok: true } }),
    });

    await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "",
      books: [real, makeBook(D, BoolFlag.TRUE)],
      dirtyBookIds: new Set([D]),
      raw: { lastUpdated: L0 },
    });

    const second = vi.mocked(api.updatePersonalBooks).mock.calls[1][1];
    expect(second.books.map((b) => [b.bookId, b.isShared])).toEqual([
      [A, BoolFlag.TRUE],
      [D, BoolFlag.TRUE],
    ]);
  });

  it("propagates a thrown request", async () => {
    const api = client({
      updatePersonalBooks: vi.fn().mockRejectedValue(new Error("offline")),
    });

    await expect(
      uploadPersonalShelf({
        apiClient: api,
        userId: USER,
        displayName: "",
        books: LOCAL,
        dirtyBookIds: new Set([D]),
        raw: null,
      }),
    ).rejects.toThrow("offline");
  });
});
