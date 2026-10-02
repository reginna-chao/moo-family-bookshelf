import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadOnboardingBooks } from "@/dialog/onboardingBooksUpload";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";
import type { ScrapedBook } from "@/content/scraper";
import { MAX_SYNC_UPLOAD_ATTEMPTS } from "@/sync/syncUpload";
import { SYNC_PAUSED_MESSAGE } from "@/sync/syncBreaker";

/**
 * `dialog/onboardingBooksUpload.ts` (#259) — onboarding's first sync is a
 * read → merge → full PUT like the regular sync, so it carries the same
 * lost-update guard: the PUT sends the read `lastUpdated` as
 * `expectedLastUpdated`, and on `409 BOOKS_CONFLICT` the list is re-read and
 * the merge rebuilt from that read (a share another device changed is taken
 * from the server, never written back stale). At most
 * `MAX_SYNC_UPLOAD_ATTEMPTS` PUTs; the last error is returned for the caller's
 * error phase. A failed read throws.
 *
 * The real merge runs here (`useAutoSetup.test.ts` stubs it). The hook-level
 * wiring — error phase, copy, `LAST_SYNC_AT_KEY` — is in `useAutoSetup.test.ts`.
 */

const USER = "user-hash";
const A = "210000000000001";
const B = "210000000000002";
const L0 = "2026-09-30T10:00:00.000Z";
const L1 = "2026-09-30T10:00:05.000Z";
const L2 = "2026-09-30T10:00:09.000Z";
const CONFLICT = {
  error: {
    code: "BOOKS_CONFLICT",
    message: "Books record changed since it was read",
  },
};

const scraped = (bookId: string): ScrapedBook => ({
  bookId,
  title: `書-${bookId}`,
  author: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isArchived: BoolFlag.FALSE,
});

const saved = (bookId: string, isShared: BoolFlag): BookEntry => ({
  bookId,
  title: `書-${bookId}`,
  author: "",
  isbn: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isShared,
});

const record = (books: BookEntry[], lastUpdated?: string) => ({
  data: { books, ...(lastUpdated === undefined ? {} : { lastUpdated }) },
});

function client(gets: unknown[], puts: unknown[]) {
  const getPersonalBooks = vi.fn();
  for (const g of gets) getPersonalBooks.mockResolvedValueOnce(g);
  const updatePersonalBooks = vi.fn();
  for (const p of puts) updatePersonalBooks.mockResolvedValueOnce(p);
  return {
    api: { getPersonalBooks, updatePersonalBooks } as unknown as ApiClient,
    getPersonalBooks,
    updatePersonalBooks,
  };
}

const upload = (api: ApiClient, books = [scraped(A), scraped(B)]) =>
  uploadOnboardingBooks({ apiClient: api, userId: USER, scrapedBooks: books });

describe("uploadOnboardingBooks", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs the merged list once, with the read stamp as precondition", async () => {
    const { api, updatePersonalBooks } = client(
      [record([saved(A, BoolFlag.TRUE)], L0)],
      [{ data: { ok: true } }],
    );

    await expect(upload(api)).resolves.toBeNull();

    expect(updatePersonalBooks).toHaveBeenCalledTimes(1);
    const [userId, body] = updatePersonalBooks.mock.calls[0];
    expect(userId).toBe(USER);
    expect(body.expectedLastUpdated).toBe(L0);
    expect(body.books.map((b: BookEntry) => [b.bookId, b.isShared])).toEqual([
      [A, BoolFlag.TRUE],
      [B, BoolFlag.FALSE],
    ]);
  });

  it.each([
    { name: "no saved record", read: { data: null } },
    { name: "a record without a stamp", read: record([]) },
  ])("sends no precondition for $name", async ({ read }) => {
    const { api, updatePersonalBooks } = client([read], [{ data: {} }]);

    await expect(upload(api)).resolves.toBeNull();

    const body = updatePersonalBooks.mock.calls[0][1];
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty(
      "expectedLastUpdated",
    );
  });

  it("re-reads on a conflict and rebuilds the second PUT from that read", async () => {
    // Read 1: A shared. Another device then un-shares A; read 2 shows it.
    const { api, getPersonalBooks, updatePersonalBooks } = client(
      [
        record([saved(A, BoolFlag.TRUE)], L0),
        record(
          [saved(A, BoolFlag.FALSE), saved("210000000000009", BoolFlag.TRUE)],
          L1,
        ),
      ],
      [CONFLICT, { data: { ok: true } }],
    );

    await expect(upload(api)).resolves.toBeNull();

    expect(getPersonalBooks).toHaveBeenCalledTimes(2);
    expect(updatePersonalBooks).toHaveBeenCalledTimes(2);
    const first = updatePersonalBooks.mock.calls[0][1];
    const second = updatePersonalBooks.mock.calls[1][1];
    expect(first.expectedLastUpdated).toBe(L0);
    expect(second.expectedLastUpdated).toBe(L1);
    // Built from read 2: A un-shared, and the saved-only book it holds kept.
    expect(second.books.map((b: BookEntry) => [b.bookId, b.isShared])).toEqual([
      [A, BoolFlag.FALSE],
      [B, BoolFlag.FALSE],
      ["210000000000009", BoolFlag.TRUE],
    ]);
  });

  it("gives up after MAX_SYNC_UPLOAD_ATTEMPTS conflicted PUTs and returns the conflict", async () => {
    const { api, getPersonalBooks, updatePersonalBooks } = client(
      [record([], L0), record([], L1), record([], L2)],
      [CONFLICT, CONFLICT, CONFLICT],
    );

    await expect(upload(api)).resolves.toEqual(CONFLICT.error);

    expect(updatePersonalBooks).toHaveBeenCalledTimes(MAX_SYNC_UPLOAD_ATTEMPTS);
    expect(getPersonalBooks).toHaveBeenCalledTimes(MAX_SYNC_UPLOAD_ATTEMPTS);
    expect(
      updatePersonalBooks.mock.calls.map(
        ([, body]) => body.expectedLastUpdated,
      ),
    ).toEqual([L0, L1, L2]);
  });

  it("returns the conflict with no second PUT when the re-read finds no record (#265)", async () => {
    // A retry built on the empty read would send no precondition and reset A.
    const { api, getPersonalBooks, updatePersonalBooks } = client(
      [record([saved(A, BoolFlag.TRUE)], L0), { data: null }],
      [CONFLICT, { data: { ok: true } }],
    );

    await expect(upload(api)).resolves.toEqual(CONFLICT.error);

    expect(getPersonalBooks).toHaveBeenCalledTimes(2);
    expect(updatePersonalBooks).toHaveBeenCalledTimes(1);
  });

  it("returns a non-conflict error at once, without a re-read", async () => {
    const error = { code: "PAYLOAD_TOO_LARGE", message: "too big" };
    const { api, getPersonalBooks, updatePersonalBooks } = client(
      [record([], L0)],
      [{ error }],
    );

    await expect(upload(api)).resolves.toEqual(error);

    expect(getPersonalBooks).toHaveBeenCalledTimes(1);
    expect(updatePersonalBooks).toHaveBeenCalledTimes(1);
  });

  it("throws when the first read fails, before any upload", async () => {
    const { api, updatePersonalBooks } = client(
      [{ error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" } }],
      [],
    );

    await expect(upload(api)).rejects.toThrow("伺服器忙碌");
    expect(updatePersonalBooks).not.toHaveBeenCalled();
  });

  it("throws when the re-read after a conflict fails, with no second PUT", async () => {
    const { api, updatePersonalBooks } = client(
      [
        record([], L0),
        { error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" } },
      ],
      [CONFLICT],
    );

    await expect(upload(api)).rejects.toThrow("伺服器忙碌");
    expect(updatePersonalBooks).toHaveBeenCalledTimes(1);
  });

  it("throws the circuit-breaker pause when the re-read no longer matches the scrape", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      saved(`2100000${String(100 + i).padStart(8, "0")}`, BoolFlag.FALSE),
    );
    const { api, updatePersonalBooks } = client(
      [record([], L0), record(many, L1)],
      [CONFLICT],
    );

    await expect(upload(api)).rejects.toThrow(SYNC_PAUSED_MESSAGE);
    expect(updatePersonalBooks).toHaveBeenCalledTimes(1);
  });
});
