import { describe, it, expect, vi } from "vitest";
import {
  normalizePersonalBooks,
  uploadPersonalShelf,
} from "@/hooks/personalShelfUpload";
import {
  BoolFlag,
  PERSONAL_BOOKS_SCHEMA_VERSION,
  type ApiClient,
  type BookEntry,
  type PersonalBooks,
} from "@/api/client";

/**
 * `hooks/personalShelfUpload.ts` (#259) — the network half of the PWA's
 * personal-shelf Save, mirror of extension/src/dialog/personalShelfUpload.ts.
 * A PATCH stays as it was; a full PUT goes through the shared
 * `putBooksRebasingOnConflict` and re-reads with the shelf's own load rule
 * (`normalizePersonalBooks`: truthy flags → `BoolFlag`), so a rebase never
 * sends a raw `true` / `"1"` an older client stored.
 *
 * The full-PUT path is reached here with a record that carries a stamp but no
 * `books` array: nothing is server-known, so `decideSaveStrategy` picks PUT.
 * The hook-level regression lives in `usePersonalShelfSave.test.ts`.
 */

const USER = "a".repeat(64);
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

const makeBook = (bookId: string, isShared: BoolFlag): BookEntry => ({
  bookId,
  title: `書-${bookId}`,
  author: "",
  isbn: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isShared,
});

function client(overrides: Record<string, unknown> = {}) {
  return {
    getPersonalBooks: vi.fn(),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    patchPersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    ...overrides,
  } as unknown as ApiClient;
}

const LOCAL = [makeBook(A, BoolFlag.TRUE), makeBook(D, BoolFlag.TRUE)];

describe("normalizePersonalBooks", () => {
  it("maps truthy / falsy stored flags onto BoolFlag", () => {
    const data = {
      books: [
        { ...makeBook(A, BoolFlag.TRUE), isShared: true, isArchived: 1 },
        { ...makeBook(D, BoolFlag.FALSE), isShared: 0, isArchived: false },
      ],
    } as unknown as PersonalBooks;

    expect(
      normalizePersonalBooks(data).map((b) => [b.isShared, b.isArchived]),
    ).toEqual([
      [BoolFlag.TRUE, BoolFlag.TRUE],
      [BoolFlag.FALSE, BoolFlag.FALSE],
    ]);
  });

  it("returns no books for a record without a books array", () => {
    expect(
      normalizePersonalBooks({ books: "x" } as unknown as PersonalBooks),
    ).toEqual([]);
  });
});

describe("uploadPersonalShelf (PWA)", () => {
  it("PATCHes a server-known dirty book and reports the landed PATCH", async () => {
    const api = client();

    const result = await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "小明",
      books: LOCAL,
      dirtyBookIds: new Set([D]),
      raw: {
        books: [makeBook(A, BoolFlag.TRUE), makeBook(D, BoolFlag.FALSE)],
        lastUpdated: L0,
      },
    });

    expect(api.updatePersonalBooks).not.toHaveBeenCalled();
    expect(api.patchPersonalBooks).toHaveBeenCalledWith(USER, [
      { bookId: D, isShared: BoolFlag.TRUE },
    ]);
    expect(result).toEqual({
      ok: true,
      landed: {
        usePut: false,
        books: LOCAL,
        patchChanges: [{ bookId: D, isShared: BoolFlag.TRUE }],
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
    const body = vi.mocked(api.updatePersonalBooks).mock.calls[0][1];
    expect(body).toMatchObject({
      futureField: "kept",
      schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
      userId: USER,
      displayName: "小明",
      books: LOCAL,
      expectedLastUpdated: L0,
    });
    expect(result).toEqual({
      ok: true,
      landed: { usePut: true, books: LOCAL, raw: { ...raw, lastUpdated: L1 } },
    });
  });

  it("rebases onto a re-read whose stored flags are not BoolFlag, sending BoolFlag", async () => {
    // An older client stored booleans; the re-read shows A un-shared as `false`.
    const reread = {
      books: [
        { ...makeBook(A, BoolFlag.FALSE), isShared: false },
        { ...makeBook(D, BoolFlag.FALSE), isShared: false },
      ],
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
    // Strict equality: the boolean `false` never reaches the wire.
    expect(calls[1][1].books.map((b) => [b.bookId, b.isShared])).toEqual([
      [A, BoolFlag.FALSE],
      [D, BoolFlag.TRUE],
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.landed.usePut) return;
    expect(result.landed.raw).toEqual(reread);
  });

  it("gives up with the conflict error after 3 conflicted PUTs", async () => {
    const api = client({
      getPersonalBooks: vi
        .fn()
        .mockResolvedValue({ data: { books: [], lastUpdated: L1 } }),
      updatePersonalBooks: vi.fn().mockResolvedValue(CONFLICT),
    });

    const result = await uploadPersonalShelf({
      apiClient: api,
      userId: USER,
      displayName: "",
      books: LOCAL,
      dirtyBookIds: new Set([D]),
      raw: { lastUpdated: L0 },
    });

    expect(api.updatePersonalBooks).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, error: CONFLICT.error });
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
