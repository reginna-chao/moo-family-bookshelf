import { describe, it, expect, vi } from "vitest";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import {
  MAX_SAVE_PUT_ATTEMPTS,
  expectedLastUpdatedOf,
  landedLastUpdatedOf,
  overlayShareFlags,
  putBooksRebasingOnConflict,
  type FullPutAttempt,
  type FullPutRead,
  type PersonalBooksRaw,
} from "moo-family-bookshelf-shared/personal/fullPutConflict";
import type { ShareFlagEntry } from "moo-family-bookshelf-shared/personal/savedDirty";

/**
 * `shared/src/personal/fullPutConflict.ts` (#259) — the full-PUT half of a
 * personal-shelf Save, shared by the Extension and the PWA. A full PUT sends
 * EVERY book's flag, so an untouched book carried the flag the screen read at
 * load; a book another device un-shared since then was written back as
 * shared. The PUT now carries the read `lastUpdated` as `expectedLastUpdated`;
 * on `409 BOOKS_CONFLICT` the record is re-read and the list rebased onto it
 * (dirty ids keep the local flag, every other id the server holds takes the
 * re-read flag, every other id the server no longer holds is sent not-shared),
 * at most `MAX_SAVE_PUT_ATTEMPTS` PUTs.
 *
 * `shared/` has no test script of its own; this suite runs in `extension-check`
 * (its path filter covers `shared/**`).
 */

interface Book extends ShareFlagEntry {
  title: string;
}

const book = (bookId: string, isShared: BoolFlag): Book => ({
  bookId,
  title: `書-${bookId}`,
  isShared,
});

const flagsOf = (books: readonly ShareFlagEntry[]) =>
  books.map((b) => [b.bookId, b.isShared]);

/** The Worker's wire error for a failed precondition (worker/src/routes/user.ts). */
const CONFLICT = {
  error: {
    code: "BOOKS_CONFLICT",
    message: "Books record changed since it was read",
  },
};

describe("MAX_SAVE_PUT_ATTEMPTS", () => {
  it("allows the first PUT plus two retries", () => {
    expect(MAX_SAVE_PUT_ATTEMPTS).toBe(3);
  });
});

describe("expectedLastUpdatedOf", () => {
  it.each([
    { name: "null", raw: null, expected: undefined },
    { name: "undefined", raw: undefined, expected: undefined },
    { name: "a record with no lastUpdated", raw: {}, expected: undefined },
    { name: "an empty string", raw: { lastUpdated: "" }, expected: undefined },
    { name: "a number", raw: { lastUpdated: 1727000000 }, expected: undefined },
    { name: "null stamp", raw: { lastUpdated: null }, expected: undefined },
    { name: "an object", raw: { lastUpdated: { t: 1 } }, expected: undefined },
    {
      name: "an ISO string",
      raw: { lastUpdated: "2026-09-30T10:00:00.000Z" },
      expected: "2026-09-30T10:00:00.000Z",
    },
    {
      name: "a non-ISO string (sent back byte-identical)",
      raw: { lastUpdated: " opaque stamp " },
      expected: " opaque stamp ",
    },
  ])("returns $expected for $name", ({ raw, expected }) => {
    expect(expectedLastUpdatedOf(raw)).toBe(expected);
  });
});

describe("landedLastUpdatedOf", () => {
  it.each<{ name: string; data: unknown; expected: string | undefined }>([
    { name: "undefined", data: undefined, expected: undefined },
    { name: "null", data: null, expected: undefined },
    { name: "a string", data: "2026-09-30T10:00:00.000Z", expected: undefined },
    { name: "a number", data: 1727000000, expected: undefined },
    { name: "a boolean", data: true, expected: undefined },
    {
      name: "a PUT response that carries no usable lastUpdated ({ ok })",
      data: { ok: true },
      expected: undefined,
    },
    {
      name: "a record with no stamp",
      data: { books: [] },
      expected: undefined,
    },
    { name: "an empty stamp", data: { lastUpdated: "" }, expected: undefined },
    {
      name: "a numeric stamp",
      data: { lastUpdated: 123 },
      expected: undefined,
    },
    { name: "a null stamp", data: { lastUpdated: null }, expected: undefined },
    {
      name: "an object stamp",
      data: { lastUpdated: { t: 1 } },
      expected: undefined,
    },
    {
      name: "the stored record",
      data: { books: [], lastUpdated: "2026-09-30T10:00:09.000Z" },
      expected: "2026-09-30T10:00:09.000Z",
    },
    {
      name: "a non-ISO stamp (returned byte-identical)",
      data: { lastUpdated: " server-write-1 " },
      expected: " server-write-1 ",
    },
  ])("returns $expected for $name", ({ data, expected }) => {
    expect(landedLastUpdatedOf(data)).toBe(expected);
  });
});

describe("overlayShareFlags", () => {
  const A = "a";
  const B = "b";
  const C = "c";

  it("returns the input array itself when no flag differs", () => {
    const books = [book(A, BoolFlag.TRUE), book(B, BoolFlag.FALSE)];
    const source = [book(B, BoolFlag.FALSE), book(A, BoolFlag.TRUE)];

    expect(overlayShareFlags(books, source, new Set())).toBe(books);
  });

  it("returns the input array itself when the source is empty", () => {
    const books = [book(A, BoolFlag.TRUE)];
    expect(overlayShareFlags(books, [], new Set())).toBe(books);
  });

  it("takes the source flag for every id it holds, keeping set and order", () => {
    const books = [
      book(A, BoolFlag.TRUE),
      book(B, BoolFlag.FALSE),
      book(C, BoolFlag.TRUE),
    ];
    // Different order and an extra id the local list does not hold.
    const source = [
      book("extra", BoolFlag.TRUE),
      book(C, BoolFlag.TRUE),
      book(A, BoolFlag.FALSE),
      book(B, BoolFlag.TRUE),
    ];

    const next = overlayShareFlags(books, source, new Set());

    expect(next).not.toBe(books);
    expect(flagsOf(next)).toEqual([
      [A, BoolFlag.FALSE],
      [B, BoolFlag.TRUE],
      [C, BoolFlag.TRUE],
    ]);
    // Other fields survive; untouched entries are reused as-is.
    expect(next[0].title).toBe(`書-${A}`);
    expect(next[2]).toBe(books[2]);
  });

  it("keeps the own flag of every id in keepIds", () => {
    const books = [book(A, BoolFlag.TRUE), book(B, BoolFlag.TRUE)];
    const source = [book(A, BoolFlag.FALSE), book(B, BoolFlag.FALSE)];

    const next = overlayShareFlags(books, source, new Set([A]));

    expect(flagsOf(next)).toEqual([
      [A, BoolFlag.TRUE],
      [B, BoolFlag.FALSE],
    ]);
  });

  it("keeps the own flag of an id the source does not hold", () => {
    const books = [book(A, BoolFlag.TRUE), book(B, BoolFlag.TRUE)];
    const source = [book(B, BoolFlag.FALSE)];

    expect(flagsOf(overlayShareFlags(books, source, new Set()))).toEqual([
      [A, BoolFlag.TRUE],
      [B, BoolFlag.FALSE],
    ]);
  });

  it("skips malformed and null source entries without throwing", () => {
    const books = [book(A, BoolFlag.TRUE), book(B, BoolFlag.TRUE)];
    const source = [
      null,
      undefined,
      { bookId: 42, isShared: BoolFlag.FALSE },
      { isShared: BoolFlag.FALSE },
      "garbage",
      book(B, BoolFlag.FALSE),
    ] as unknown as ShareFlagEntry[];

    expect(flagsOf(overlayShareFlags(books, source, new Set()))).toEqual([
      [A, BoolFlag.TRUE],
      [B, BoolFlag.FALSE],
    ]);
  });

  it("does not mutate its inputs", () => {
    const books = [book(A, BoolFlag.TRUE)];
    const source = [book(A, BoolFlag.FALSE)];
    const before = JSON.stringify({ books, source });

    overlayShareFlags(books, source, new Set());

    expect(JSON.stringify({ books, source })).toBe(before);
  });
});

describe("putBooksRebasingOnConflict", () => {
  const A = "a";
  const D = "dirty";
  const L0 = "2026-09-30T10:00:00.000Z";
  const L1 = "2026-09-30T10:00:05.000Z";
  const L2 = "2026-09-30T10:00:09.000Z";

  /** The screen read A shared and D not shared; the user shared D. */
  const LOCAL = [book(A, BoolFlag.TRUE), book(D, BoolFlag.TRUE)];
  const DIRTY = new Set([D]);
  const raw0 = (): PersonalBooksRaw => ({
    books: [book(A, BoolFlag.TRUE), book(D, BoolFlag.FALSE)],
    lastUpdated: L0,
    extra: "kept",
  });

  /** A re-read where another device has un-shared A. */
  const rereadRecord = (stamp: string) => ({
    books: [book(A, BoolFlag.FALSE), book(D, BoolFlag.FALSE)],
    lastUpdated: stamp,
  });

  const parse = (data: unknown): FullPutRead<Book> => {
    const record = data as { books: Book[] } | null;
    return { books: record?.books ?? [], raw: record };
  };

  type Put = (attempt: FullPutAttempt<Book>) => Promise<ApiResponse<unknown>>;
  type Get = () => Promise<ApiResponse<unknown>>;

  function run(put: Put, get: Get, raw: PersonalBooksRaw = raw0()) {
    return putBooksRebasingOnConflict<Book>({
      books: LOCAL,
      dirtyBookIds: DIRTY,
      raw,
      put,
      get,
      parse,
    });
  }

  it("lands on the first PUT with the read stamp as precondition", async () => {
    const put = vi.fn<Put>().mockResolvedValue({ data: { lastUpdated: L1 } });
    const get = vi.fn<Get>();
    const raw = raw0();

    const result = await run(put, get, raw);

    expect(put).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    const attempt = put.mock.calls[0][0];
    expect(attempt.expectedLastUpdated).toBe(L0);
    expect(attempt.books).toBe(LOCAL);
    expect(attempt.raw).toBe(raw);
    expect(result).toEqual({
      ok: true,
      books: LOCAL,
      raw: { ...raw, lastUpdated: L1 },
    });
  });

  it.each([
    { name: "no record", raw: null },
    { name: "a record without a stamp", raw: { books: [] } },
    { name: "an empty stamp", raw: { books: [], lastUpdated: "" } },
  ])("sends no precondition for $name", async ({ raw }) => {
    const put = vi.fn<Put>().mockResolvedValue({ data: { ok: true } });

    const result = await run(put, vi.fn<Get>(), raw);

    expect(put.mock.calls[0][0].expectedLastUpdated).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("re-reads on a conflict and lands a PUT rebased onto the re-read flags", async () => {
    const put = vi
      .fn<Put>()
      .mockResolvedValueOnce(CONFLICT)
      .mockResolvedValueOnce({ data: { lastUpdated: L2 } });
    const get = vi.fn<Get>().mockResolvedValue({ data: rereadRecord(L1) });

    const result = await run(put, get);

    expect(put).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    const second = put.mock.calls[1][0];
    // A takes the re-read (un-shared) flag; the dirty D keeps the local share.
    expect(flagsOf(second.books)).toEqual([
      [A, BoolFlag.FALSE],
      [D, BoolFlag.TRUE],
    ]);
    expect(second.expectedLastUpdated).toBe(L1);
    expect(second.raw).toEqual(rereadRecord(L1));
    expect(result).toEqual({
      ok: true,
      books: second.books,
      raw: { ...rereadRecord(L1), lastUpdated: L2 },
    });
  });

  it("gives up with the conflict error after exactly MAX_SAVE_PUT_ATTEMPTS PUTs", async () => {
    const put = vi.fn<Put>().mockResolvedValue(CONFLICT);
    const get = vi
      .fn<Get>()
      .mockResolvedValueOnce({ data: rereadRecord(L1) })
      .mockResolvedValueOnce({ data: rereadRecord(L2) });

    const result = await run(put, get);

    expect(put).toHaveBeenCalledTimes(MAX_SAVE_PUT_ATTEMPTS);
    // No re-read after the last conflict: nothing would use it.
    expect(get).toHaveBeenCalledTimes(MAX_SAVE_PUT_ATTEMPTS - 1);
    expect(put.mock.calls.map(([a]) => a.expectedLastUpdated)).toEqual([
      L0,
      L1,
      L2,
    ]);
    expect(result).toEqual({ ok: false, error: CONFLICT.error });
  });

  it("stops at once on a non-conflict error, without a re-read", async () => {
    const error = { code: "PAYLOAD_TOO_LARGE", message: "too big" };
    const put = vi.fn<Put>().mockResolvedValue({ error });
    const get = vi.fn<Get>();

    const result = await run(put, get);

    expect(put).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error });
  });

  it("stops after a non-conflict error on a retry", async () => {
    const error = { code: "RATE_LIMITED", message: "稍後再試" };
    const put = vi
      .fn<Put>()
      .mockResolvedValueOnce(CONFLICT)
      .mockResolvedValueOnce({ error });
    const get = vi.fn<Get>().mockResolvedValue({ data: rereadRecord(L1) });

    const result = await run(put, get);

    expect(put).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, error });
  });

  it("reports the conflict error when the re-read fails", async () => {
    const put = vi.fn<Put>().mockResolvedValue(CONFLICT);
    const get = vi.fn<Get>().mockResolvedValue({
      error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" },
    });

    const result = await run(put, get);

    expect(put).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, error: CONFLICT.error });
  });

  /** The dialog's load rule: anything without a `books` array is no record. */
  const parseLikeLoad = (data: unknown): FullPutRead<Book> => {
    const record = data as Record<string, unknown> | null | undefined;
    const books = record?.books;
    return record && Array.isArray(books)
      ? { books: books as Book[], raw: record }
      : { books: [], raw: null };
  };

  it.each([
    { name: "no record (data: null)", data: null },
    { name: "no data at all", data: undefined },
    { name: "a record the load rule rejects", data: { lastUpdated: L1 } },
    {
      name: "a books field that is no list",
      data: { books: "x", lastUpdated: L1 },
    },
  ])(
    "reports the conflict with no further PUT when the re-read finds $name",
    async ({ data }) => {
      const put = vi
        .fn<Put>()
        .mockResolvedValueOnce(CONFLICT)
        .mockResolvedValue({ data: { lastUpdated: L2 } });
      const get = vi.fn<Get>().mockResolvedValue({ data });

      const result = await putBooksRebasingOnConflict<Book>({
        books: LOCAL,
        dirtyBookIds: DIRTY,
        raw: raw0(),
        put,
        get,
        parse: parseLikeLoad,
      });

      // A retry built on no record would carry no precondition: never sent.
      expect(put).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: false, error: CONFLICT.error });
    },
  );

  it("still retries when the re-read finds a record (positive companion)", async () => {
    const put = vi
      .fn<Put>()
      .mockResolvedValueOnce(CONFLICT)
      .mockResolvedValueOnce({ data: { lastUpdated: L2 } });
    const get = vi.fn<Get>().mockResolvedValue({ data: rereadRecord(L1) });

    const result = await putBooksRebasingOnConflict<Book>({
      books: LOCAL,
      dirtyBookIds: DIRTY,
      raw: raw0(),
      put,
      get,
      parse: parseLikeLoad,
    });

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][0].expectedLastUpdated).toBe(L1);
    expect(result.ok).toBe(true);
  });

  it.each([
    { name: "{ ok }, with no usable lastUpdated", data: { ok: true } },
    { name: "no data", data: undefined },
    { name: "null data", data: null },
    { name: "an empty stamp", data: { lastUpdated: "" } },
    { name: "a numeric stamp", data: { lastUpdated: 123 } },
  ])(
    "keeps the stamp the landed attempt read when the PUT answers $name",
    async ({ data }) => {
      const put = vi
        .fn<Put>()
        .mockResolvedValueOnce(CONFLICT)
        .mockResolvedValueOnce({ data });
      const get = vi.fn<Get>().mockResolvedValue({ data: rereadRecord(L1) });

      const result = await run(put, get);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.raw?.lastUpdated).toBe(L1);
    },
  );

  it("builds a stamped record when the PUT lands with no prior record", async () => {
    const put = vi.fn<Put>().mockResolvedValue({ data: { lastUpdated: L1 } });

    const result = await run(put, vi.fn<Get>(), null);

    expect(result).toEqual({
      ok: true,
      books: LOCAL,
      raw: { lastUpdated: L1 },
    });
  });

  it("propagates a thrown PUT", async () => {
    const put = vi.fn<Put>().mockRejectedValue(new Error("network down"));

    await expect(run(put, vi.fn<Get>())).rejects.toThrow("network down");
  });

  it("propagates a thrown re-read", async () => {
    const put = vi.fn<Put>().mockResolvedValue(CONFLICT);
    const get = vi.fn<Get>().mockRejectedValue(new Error("offline"));

    await expect(run(put, get)).rejects.toThrow("offline");
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("keeps the local book set when the re-read lacks or adds ids", async () => {
    const put = vi
      .fn<Put>()
      .mockResolvedValueOnce(CONFLICT)
      .mockResolvedValueOnce({ data: { lastUpdated: L2 } });
    const get = vi.fn<Get>().mockResolvedValue({
      data: { books: [book("other", BoolFlag.TRUE)], lastUpdated: L1 },
    });

    const result = await run(put, get);

    // Set and order kept, `other` not added; the non-dirty `a` the re-read
    // lacks goes not-shared, the dirty D keeps its local share.
    expect(flagsOf(put.mock.calls[1][0].books)).toEqual([
      [A, BoolFlag.FALSE],
      [D, BoolFlag.TRUE],
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.books).toBe(put.mock.calls[1][0].books);
  });

  describe("a book the re-read no longer holds (removed elsewhere, #236)", () => {
    const B = "b";

    /** One conflict, then the re-read(s) in order, then a landing PUT. */
    async function rebaseOnto(
      books: Book[],
      dirty: ReadonlySet<string>,
      rereads: unknown[][],
    ) {
      const put = vi.fn<Put>();
      const get = vi.fn<Get>();
      rereads.forEach((reread, i) => {
        put.mockResolvedValueOnce(CONFLICT);
        get.mockResolvedValueOnce({
          data: { books: reread, lastUpdated: `reread-${i + 1}` },
        });
      });
      put.mockResolvedValueOnce({ data: { lastUpdated: L2 } });
      const result = await putBooksRebasingOnConflict<Book>({
        books,
        dirtyBookIds: dirty,
        raw: raw0(),
        put,
        get,
        parse,
      });
      return { put, result };
    }

    it("leaves an already not-shared lacking id as is, sending the input list itself", async () => {
      const books = [book(A, BoolFlag.FALSE), book(D, BoolFlag.TRUE)];

      // The re-read holds only D (not shared there); D is dirty, A is gone.
      const { put, result } = await rebaseOnto(books, DIRTY, [
        [book(D, BoolFlag.FALSE)],
      ]);

      expect(put).toHaveBeenCalledTimes(2);
      expect(put.mock.calls[1][0].books).toBe(books);
      expect(flagsOf(put.mock.calls[1][0].books)).toEqual([
        [A, BoolFlag.FALSE],
        [D, BoolFlag.TRUE],
      ]);
      expect(result.ok).toBe(true);
    });

    it("keeps the local share of a DIRTY id the re-read lacks", async () => {
      const books = [book(A, BoolFlag.TRUE), book(D, BoolFlag.TRUE)];

      // The re-read still holds A (shared) but no longer D.
      const { put } = await rebaseOnto(books, DIRTY, [
        [book(A, BoolFlag.TRUE)],
      ]);

      expect(flagsOf(put.mock.calls[1][0].books)).toEqual([
        [A, BoolFlag.TRUE],
        [D, BoolFlag.TRUE],
      ]);
    });

    it("judges each conflict round on its own re-read", async () => {
      const books = [book(A, BoolFlag.TRUE), book(D, BoolFlag.TRUE)];

      // Round 1 lacks A; round 2 holds A shared again.
      const { put, result } = await rebaseOnto(books, DIRTY, [
        [book(D, BoolFlag.FALSE)],
        [book(A, BoolFlag.TRUE), book(D, BoolFlag.FALSE)],
      ]);

      expect(put).toHaveBeenCalledTimes(MAX_SAVE_PUT_ATTEMPTS);
      expect(flagsOf(put.mock.calls[1][0].books)).toEqual([
        [A, BoolFlag.FALSE],
        [D, BoolFlag.TRUE],
      ]);
      expect(flagsOf(put.mock.calls[2][0].books)).toEqual([
        [A, BoolFlag.TRUE],
        [D, BoolFlag.TRUE],
      ]);
      expect(put.mock.calls[2][0].expectedLastUpdated).toBe("reread-2");
      expect(result.ok).toBe(true);
    });

    it("does not count malformed or null re-read entries as holding a book", async () => {
      const books = [
        book(A, BoolFlag.TRUE),
        book(B, BoolFlag.TRUE),
        book(D, BoolFlag.TRUE),
      ];

      const { put } = await rebaseOnto(books, DIRTY, [
        [
          null,
          undefined,
          "a",
          { isShared: BoolFlag.TRUE },
          { bookId: 42, isShared: BoolFlag.TRUE },
          { bookId: [A], isShared: BoolFlag.TRUE },
          // Positive companion: a well-formed entry does hold its book.
          book(B, BoolFlag.TRUE),
        ],
      ]);

      expect(flagsOf(put.mock.calls[1][0].books)).toEqual([
        [A, BoolFlag.FALSE],
        [B, BoolFlag.TRUE],
        [D, BoolFlag.TRUE],
      ]);
    });

    it("does not mutate the input list", async () => {
      const books = [book(A, BoolFlag.TRUE), book(D, BoolFlag.TRUE)];
      const before = JSON.stringify(books);

      await rebaseOnto(books, DIRTY, [[]]);

      expect(JSON.stringify(books)).toBe(before);
    });
  });
});
