import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { USER1 } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type UserBooksRecord,
} from "../../src/kv/schema";

/**
 * `removedUnsharedBookIds` on `user:{id}` (#312) — the server-owned list of
 * real-id books removed from the books record while NOT shared, so the
 * Extension's 新書預設開放 never auto-shares such a book when a later sync
 * brings it back. The pure rule is pinned by
 * `worker/tests/unit/removedUnsharedBooks.test.ts`; this suite pins the wiring.
 *
 * `PUT /api/user/:id/books` is the only writer: it recomputes the list from
 * the record it read and the books it saves, stores it only when non-empty
 * (a user who never lost an unshared book keeps the old record shape, no key
 * at all), ignores any value the client sends (the Extension sync spreads the
 * read record into its PUT body), and writes nothing on 409 / 400. Every other
 * `user:{id}` writer — PATCH books, PUT family-prefs, the family displayName
 * PUT — carries the stored list through untouched; GET returns it. An id
 * longer than `MAX_REMOVED_UNSHARED_BOOK_ID_LENGTH` is never tombstoned, so it
 * cannot grow the list across PUTs (#312 review C1); since #316 a PUT drops a
 * NEW one, so only a grandfathered stored record can still hold such an id.
 *
 * Requests run WITHOUT `DEV_MODE` and spread the Rate Limiting binding stubs,
 * like a production deploy; each case gets a fresh KV, so the hourly
 * `put-books` / `family-write` counters never come near their ceilings.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const BOOKS_PATH = `/api/user/${USER1}/books`;
const CALLER_IP = "10.0.3.12";
const FAMILY_ID = "abcd-1234";
const SEEDED_AT = "2026-03-01T11:00:00.000Z";

const X = "210439468000101";
const Y = "210439468000102";
const Z = "210439468000103";
const LEGACY = "b1";

let kv: KVNamespace;
let token: string;

function book(bookId: string, isShared: BoolFlag): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "Author",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared,
  };
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "cf-connecting-ip": CALLER_IP,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return Promise.resolve(
    app.request(path, init, { KV: kv, ...rateLimitBindings() }),
  );
}

function putBooks(body: Record<string, unknown>): Promise<Response> {
  return send("PUT", BOOKS_PATH, body);
}

/** Seed `user:{USER1}` directly (no handler involved), stamped `SEEDED_AT`. */
async function seedRecord(extra: Partial<UserBooksRecord>): Promise<void> {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId: USER1,
    displayName: "Alice",
    books: [],
    lastUpdated: SEEDED_AT,
    ...extra,
  };
  await kv.put(kvKeys.user(USER1), JSON.stringify(record));
}

async function storedRecord(): Promise<UserBooksRecord | null> {
  return kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
}

async function storedList(): Promise<string[] | undefined> {
  return (await storedRecord())?.removedUnsharedBookIds;
}

/** True when the stored record carries the key at all (even an empty array). */
async function storedHasKey(): Promise<boolean> {
  const raw = await kv.get(kvKeys.user(USER1));
  expect(raw).not.toBeNull();
  return "removedUnsharedBookIds" in (JSON.parse(raw as string) as object);
}

beforeEach(async () => {
  kv = createMockKV();
  token = await seedAuthToken(kv, USER1);
});

describe("PUT /api/user/:id/books — #312 regression: an unshared book removed and synced back", () => {
  it("tombstones the removed unshared book, then clears it when the book returns", async () => {
    // 1. X saved NOT shared.
    let res = await putBooks({
      books: [book(X, BoolFlag.FALSE), book(Y, BoolFlag.TRUE)],
    });
    expect(res.status).toBe(200);
    expect(await storedHasKey()).toBe(false);

    // 2. A save without X (pruned / returned to Readmoo) tombstones it.
    res = await putBooks({ books: [book(Y, BoolFlag.TRUE)] });
    expect(res.status).toBe(200);
    expect(await storedList()).toEqual([X]);
    const json = (await res.json()) as Json;
    expect(json.data.removedUnsharedBookIds).toEqual([X]);

    // 3. X comes back: the tombstone goes, X keeps the flag it was sent with.
    res = await putBooks({
      books: [book(X, BoolFlag.TRUE), book(Y, BoolFlag.TRUE)],
    });
    expect(res.status).toBe(200);
    expect(await storedHasKey()).toBe(false);
    const stored = await storedRecord();
    expect(stored?.books.map((b) => [b.bookId, b.isShared])).toEqual([
      [X, BoolFlag.TRUE],
      [Y, BoolFlag.TRUE],
    ]);
  });

  it("keeps a returning book unshared when it comes back unshared", async () => {
    await seedRecord({
      books: [book(Y, BoolFlag.TRUE)],
      removedUnsharedBookIds: [X],
    });

    const res = await putBooks({
      books: [book(X, BoolFlag.FALSE), book(Y, BoolFlag.TRUE)],
    });

    expect(res.status).toBe(200);
    expect(await storedHasKey()).toBe(false);
    expect((await storedRecord())?.books[0]).toMatchObject({
      bookId: X,
      isShared: BoolFlag.FALSE,
    });
  });
});

describe("PUT /api/user/:id/books — what gets tombstoned", () => {
  it("never tombstones a book removed while shared", async () => {
    await seedRecord({
      books: [book(X, BoolFlag.TRUE), book(Y, BoolFlag.FALSE)],
    });

    const res = await putBooks({ books: [book(Y, BoolFlag.FALSE)] });

    expect(res.status).toBe(200);
    expect(await storedHasKey()).toBe(false);
  });

  it("never tombstones a removed legacy short id", async () => {
    await seedRecord({
      books: [book(LEGACY, BoolFlag.FALSE), book(Y, BoolFlag.FALSE)],
    });

    const res = await putBooks({ books: [book(Y, BoolFlag.FALSE)] });

    expect(res.status).toBe(200);
    expect(await storedHasKey()).toBe(false);
  });

  it("keeps the old record shape for a user who never lost an unshared book", async () => {
    await putBooks({ books: [book(X, BoolFlag.FALSE)] });
    const res = await putBooks({
      books: [book(X, BoolFlag.TRUE), book(Y, BoolFlag.FALSE)],
    });

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.user(USER1))).not.toContain(
      "removedUnsharedBookIds",
    );
    const json = (await res.json()) as Json;
    expect("removedUnsharedBookIds" in json.data).toBe(false);
  });

  it("never tombstones a removed id longer than the length cap (#312 C1)", async () => {
    // A PUT now drops a new over-long id (#316), so only a record stored
    // before that bound can still hold one: seed it directly, grandfathered.
    const longId = "9".repeat(200);
    await seedRecord({
      books: [book(longId, BoolFlag.FALSE), book(Y, BoolFlag.TRUE)],
    });

    const res = await putBooks({ books: [book(Y, BoolFlag.TRUE)] });

    expect(res.status).toBe(200);
    // Positive companion: the save landed and really removed the long id.
    expect((await storedRecord())?.books.map((b) => b.bookId)).toEqual([Y]);
    expect(await storedHasKey()).toBe(false);
  });

  it("tombstones a 15-digit id removed alongside an over-long one", async () => {
    // Seeded directly: a PUT drops a new over-long id (#316), see the C1 case.
    const longId = "9".repeat(200);
    await seedRecord({
      books: [book(longId, BoolFlag.FALSE), book(X, BoolFlag.FALSE)],
    });

    const res = await putBooks({ books: [] });

    expect(res.status).toBe(200);
    expect((await storedRecord())?.books).toEqual([]);
    expect(await storedList()).toEqual([X]);
  });

  it("accumulates removals across saves, oldest first", async () => {
    await seedRecord({
      books: [book(X, BoolFlag.FALSE), book(Y, BoolFlag.FALSE)],
    });

    await putBooks({ books: [book(Y, BoolFlag.FALSE)] });
    await putBooks({ books: [book(Z, BoolFlag.FALSE)] });

    expect(await storedList()).toEqual([X, Y]);
  });
});

describe("PUT /api/user/:id/books — a client-sent list is ignored", () => {
  it.each<{ label: string; value: unknown }>([
    { label: "a list of real ids", value: [Z] },
    { label: "a string", value: "garbage" },
    { label: "a number", value: 42 },
    { label: "an object", value: { ids: [Z] } },
    { label: "null", value: null },
  ])("accepts $label without storing it", async ({ value }) => {
    const res = await putBooks({
      books: [book(X, BoolFlag.FALSE)],
      removedUnsharedBookIds: value,
    });

    expect(res.status).toBe(200);
    expect(await storedHasKey()).toBe(false);
  });

  it("cannot clear a stored tombstone by sending an empty list", async () => {
    await seedRecord({
      books: [book(Y, BoolFlag.FALSE)],
      removedUnsharedBookIds: [X],
    });

    const res = await putBooks({
      books: [book(Y, BoolFlag.FALSE)],
      removedUnsharedBookIds: [],
    });

    expect(res.status).toBe(200);
    expect(await storedList()).toEqual([X]);
  });

  it("stores only the server-computed list when the client sends another", async () => {
    await seedRecord({
      books: [book(X, BoolFlag.FALSE), book(Y, BoolFlag.FALSE)],
    });

    const res = await putBooks({
      books: [book(Y, BoolFlag.FALSE)],
      removedUnsharedBookIds: [Z, Y],
    });

    expect(res.status).toBe(200);
    expect(await storedList()).toEqual([X]);
  });
});

describe("PUT /api/user/:id/books — refused saves write no tombstone", () => {
  it("writes nothing on 409 BOOKS_CONFLICT", async () => {
    await seedRecord({ books: [book(X, BoolFlag.FALSE)] });
    const before = await kv.get(kvKeys.user(USER1));

    const res = await putBooks({
      books: [book(Y, BoolFlag.FALSE)],
      expectedLastUpdated: "2026-03-01T10:00:00.000Z",
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe("BOOKS_CONFLICT");
    expect(await kv.get(kvKeys.user(USER1))).toBe(before);
    expect(await storedHasKey()).toBe(false);
  });

  it("writes nothing on 400 INVALID_FIELDS", async () => {
    await seedRecord({ books: [book(X, BoolFlag.FALSE)] });
    const before = await kv.get(kvKeys.user(USER1));

    const res = await putBooks({
      books: [book(Y, BoolFlag.FALSE)],
      expectedLastUpdated: 42,
    });

    expect(res.status).toBe(400);
    expect(await kv.get(kvKeys.user(USER1))).toBe(before);
  });

  it("tombstones on a matching precondition (positive companion)", async () => {
    await seedRecord({ books: [book(X, BoolFlag.FALSE)] });

    const res = await putBooks({
      books: [book(Y, BoolFlag.FALSE)],
      expectedLastUpdated: SEEDED_AT,
    });

    expect(res.status).toBe(200);
    expect(await storedList()).toEqual([X]);
  });
});

describe("GET /api/user/:id/books — returns the stored list", () => {
  it("includes removedUnsharedBookIds in data", async () => {
    await seedRecord({
      books: [book(Y, BoolFlag.FALSE)],
      removedUnsharedBookIds: [X, Z],
    });

    const res = await send("GET", BOOKS_PATH);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.removedUnsharedBookIds).toEqual([X, Z]);
  });
});

describe("other user:{id} writers carry the stored list through", () => {
  beforeEach(async () => {
    await seedRecord({
      books: [book(Y, BoolFlag.FALSE)],
      removedUnsharedBookIds: [X, Z],
    });
  });

  it("PATCH /api/user/:id/books keeps it", async () => {
    const res = await send("PATCH", BOOKS_PATH, {
      changes: [{ bookId: Y, isShared: BoolFlag.TRUE }],
    });

    expect(res.status).toBe(200);
    const stored = await storedRecord();
    expect(stored?.books[0].isShared).toBe(BoolFlag.TRUE);
    expect(stored?.removedUnsharedBookIds).toEqual([X, Z]);
  });

  it("PUT /api/user/:id/family-prefs keeps it", async () => {
    const res = await send("PUT", `/api/user/${USER1}/family-prefs`, {
      hidden: [],
    });

    expect(res.status).toBe(200);
    expect(await storedList()).toEqual([X, Z]);
  });

  it("PUT /api/family/:id/member/:uid/displayName keeps it", async () => {
    await kv.put(
      kvKeys.family(FAMILY_ID),
      JSON.stringify({
        familyId: FAMILY_ID,
        ownerId: USER1,
        members: [
          { userId: USER1, displayName: "Alice", canLend: BoolFlag.TRUE },
        ],
        maxMembers: 2,
        createdAt: SEEDED_AT,
      }),
    );
    await kv.put(kvKeys.member(USER1), FAMILY_ID);

    const res = await send(
      "PUT",
      `/api/family/${FAMILY_ID}/member/${USER1}/displayName`,
      { displayName: "Alicia" },
    );

    expect(res.status).toBe(200);
    const stored = await storedRecord();
    // Positive companion: the write really landed on user:{id}.
    expect(stored?.displayName).toBe("Alicia");
    expect(stored?.removedUnsharedBookIds).toEqual([X, Z]);
  });
});

describe("DELETE /api/user/:id — removes the list with the record", () => {
  it("leaves no user:{id} record behind", async () => {
    await seedRecord({
      books: [book(Y, BoolFlag.FALSE)],
      removedUnsharedBookIds: [X],
    });

    const res = await send("DELETE", `/api/user/${USER1}`);

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.user(USER1))).toBeNull();
  });
});
