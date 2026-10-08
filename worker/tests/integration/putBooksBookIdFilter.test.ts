import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelfSnapshot,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * PUT /api/user/:id/books — new malformed bookIds are DROPPED, not rejected.
 *
 * A bookId that is not a real Readmoo id (12+ digits, `isRealBookId` in
 * `shared/src/api/bookId.ts`) and is not already in the caller's stored record
 * never reaches `user:{id}`, the response, or a refreshed public snapshot. Ids
 * already stored (legacy short ids from an old scraper fallback) are
 * grandfathered so the Extension can resolve them client-side. One log line per
 * request, carrying a count only.
 */

const LOG_TAG = "PUT_BOOKS_INVALID_BOOK_ID_DROPPED";

const REAL_ID = "210439468000101";
const OTHER_REAL_ID = "210439468000102";
/** A legacy short id that sits in the stored record before the save. */
const STORED_SHORT_ID = "b-legacy-1";
/** A short id the client sends for the first time — must be dropped. */
const NEW_SHORT_ID = "b-new-1";
const NEW_SHORT_TITLE = "Dropped Title";

let kv: KVNamespace;

function request(method: string, path: string, body: unknown, token: string) {
  return app.request(
    path,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
    { KV: kv, DEV_MODE: "1" },
  );
}

function book(bookId: string, overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.FALSE,
    ...overrides,
  };
}

/** Seed a pre-existing `user:{id}` record, as an older Extension left it. */
async function seedStoredBooks(userId: string, books: BookEntry[]) {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId,
    displayName: "Test User",
    books,
    lastUpdated: "2020-01-01T00:00:00.000Z",
  };
  await kv.put(kvKeys.user(userId), JSON.stringify(record));
}

function putBooks(userId: string, token: string, books: BookEntry[]) {
  return request("PUT", `/api/user/${userId}/books`, { books }, token);
}

async function storedBookIds(userId: string): Promise<string[] | undefined> {
  const record = await kv.get<UserBooksRecord>(kvKeys.user(userId), "json");
  return record?.books.map((b) => b.bookId);
}

/** Every console.warn call carrying the drop tag. */
function dropLogCalls(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter((args: unknown[]) => args[0] === LOG_TAG);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  kv = createMockKV();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/user/:id/books — malformed bookId filter", () => {
  it("keeps a stored short id and a real id, and drops a new short id", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedStoredBooks(USER1, [book(STORED_SHORT_ID)]);

    const res = await putBooks(USER1, token, [
      book(STORED_SHORT_ID),
      book(NEW_SHORT_ID, { title: NEW_SHORT_TITLE }),
      book(REAL_ID),
    ]);

    // Dropped, never rejected: one bad entry must not fail the whole sync.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.books.map((b: Json) => b.bookId)).toEqual([
      STORED_SHORT_ID,
      REAL_ID,
    ]);
    expect(await storedBookIds(USER1)).toEqual([STORED_SHORT_ID, REAL_ID]);
    const raw = await kv.get(kvKeys.user(USER1));
    expect(raw).not.toContain(NEW_SHORT_ID);
    expect(raw).not.toContain(NEW_SHORT_TITLE);
  });

  it("logs the drop exactly once, with a count and nothing that identifies the user or book", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedStoredBooks(USER1, [book(STORED_SHORT_ID)]);

    await putBooks(USER1, token, [
      book(STORED_SHORT_ID),
      book(NEW_SHORT_ID, { title: NEW_SHORT_TITLE }),
      book(REAL_ID),
    ]);

    const calls = dropLogCalls(warn);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([LOG_TAG, { count: 1 }]);
    const logged = JSON.stringify(calls[0]);
    for (const secret of [
      USER1,
      NEW_SHORT_ID,
      NEW_SHORT_TITLE,
      STORED_SHORT_ID,
      REAL_ID,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("logs once per request even when several books are dropped", async () => {
    const token = await seedAuthToken(kv, USER1);

    await putBooks(USER1, token, [
      book("short-a"),
      book(REAL_ID),
      book("short-b"),
      book("short-c"),
    ]);

    const calls = dropLogCalls(warn);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([LOG_TAG, { count: 3 }]);
  });

  it("does not log when nothing is dropped", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedStoredBooks(USER1, [book(STORED_SHORT_ID)]);

    const res = await putBooks(USER1, token, [
      book(STORED_SHORT_ID),
      book(REAL_ID),
      book(OTHER_REAL_ID),
    ]);

    expect(res.status).toBe(200);
    expect(await storedBookIds(USER1)).toEqual([
      STORED_SHORT_ID,
      REAL_ID,
      OTHER_REAL_ID,
    ]);
    // Positive companion to the "no call" assertion: the tag the filter is
    // checked against is the one the drop case above actually emits.
    expect(dropLogCalls(warn)).toHaveLength(0);
  });

  it("drops every short id on a first save, answering 200 with an empty list", async () => {
    const token = await seedAuthToken(kv, USER1);

    const res = await putBooks(USER1, token, [book("b1"), book("b2")]);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.books).toEqual([]);
    expect(await storedBookIds(USER1)).toEqual([]);
    expect(dropLogCalls(warn)).toEqual([[LOG_TAG, { count: 2 }]]);
  });

  it("grandfathers only ids in the CALLER's own record, never another user's", async () => {
    const token = await seedAuthToken(kv, USER1);
    // USER2 still holds the legacy id; USER1 has never stored it.
    await seedStoredBooks(USER2, [book(STORED_SHORT_ID)]);

    const res = await putBooks(USER1, token, [
      book(STORED_SHORT_ID),
      book(REAL_ID),
    ]);

    expect(res.status).toBe(200);
    expect(await storedBookIds(USER1)).toEqual([REAL_ID]);
  });

  it("stops grandfathering a short id once a save has removed it", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedStoredBooks(USER1, [book(STORED_SHORT_ID), book(REAL_ID)]);

    // The client resolves the legacy entry and saves without it…
    await putBooks(USER1, token, [book(REAL_ID)]);
    // …so a later save that re-sends it is a NEW malformed id again.
    const res = await putBooks(USER1, token, [
      book(STORED_SHORT_ID),
      book(REAL_ID),
    ]);

    expect(res.status).toBe(200);
    expect(await storedBookIds(USER1)).toEqual([REAL_ID]);
  });

  it("still rejects an empty bookId with 400 INVALID_PAYLOAD and writes nothing", async () => {
    const token = await seedAuthToken(kv, USER1);

    const res = await putBooks(USER1, token, [book(""), book(REAL_ID)]);

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_PAYLOAD");
    expect(await kv.get(kvKeys.user(USER1))).toBeNull();
    expect(dropLogCalls(warn)).toHaveLength(0);
  });

  it("never publishes a dropped book into a refreshed public-shelf snapshot", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedStoredBooks(USER1, [book(REAL_ID, { isShared: BoolFlag.TRUE })]);
    const shelfRes = await request(
      "POST",
      `/api/user/${USER1}/public-shelf`,
      { title: "公開書櫃", expiresDays: 30 },
      token,
    );
    expect(shelfRes.status).toBe(201);
    const shareToken = ((await shelfRes.json()) as Json).data.shelf
      .shareToken as string;

    const res = await putBooks(USER1, token, [
      book(REAL_ID, { isShared: BoolFlag.TRUE }),
      book(NEW_SHORT_ID, { isShared: BoolFlag.TRUE, title: NEW_SHORT_TITLE }),
    ]);

    expect(res.status).toBe(200);
    const snapshot = await kv.get<PublicShelfSnapshot>(
      kvKeys.publicShelf(shareToken),
      "json",
    );
    // Positive companion: the snapshot WAS refreshed from this save and still
    // publishes the real shared book…
    expect(snapshot?.books.map((b) => b.bookId)).toEqual([REAL_ID]);
    // …and the dropped one is nowhere in it.
    expect(JSON.stringify(snapshot)).not.toContain(NEW_SHORT_TITLE);
  });
});

describe("PATCH /api/user/:id/books — grandfathered short ids", () => {
  it("still updates isShared on a stored short id", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedStoredBooks(USER1, [book(STORED_SHORT_ID), book(REAL_ID)]);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: [{ bookId: STORED_SHORT_ID, isShared: BoolFlag.TRUE }] },
      token,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.applied).toBe(1);
    const record = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(
      record?.books.find((b) => b.bookId === STORED_SHORT_ID)?.isShared,
    ).toBe(BoolFlag.TRUE);
    expect(record?.books.map((b) => b.bookId)).toEqual([
      STORED_SHORT_ID,
      REAL_ID,
    ]);
    expect(dropLogCalls(warn)).toHaveLength(0);
  });
});
