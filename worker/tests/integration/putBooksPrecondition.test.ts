/**
 * PUT /api/user/:id/books — the optional `expectedLastUpdated` precondition (#249).
 *
 * The Extension sync is GET → merge → full PUT. A share toggle saved (PATCH)
 * between that GET and PUT used to be overwritten by the sync's stale payload.
 * The PUT now carries the `lastUpdated` it read; a mismatch answers
 * `409 BOOKS_CONFLICT` and writes nothing (no `user:{id}`, no `public:*`).
 *
 * Requests run WITHOUT `DEV_MODE` (bindings injected) so the hourly `put-books`
 * counter is live: the 400 path must still charge it, and the KV op logs below
 * pin the real per-request trail. `Date` is pinned so every `lastUpdated` a
 * handler writes is a known value rather than a wall-clock race.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { USER1 } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { writePublicSnapshot } from "../../src/services/publicShelf";
import { BOOKS_CONFLICT_CODE } from "moo-family-bookshelf-shared/personal/saveErrors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PATH = `/api/user/${USER1}/books`;
const CALLER_IP = "10.0.0.249";

/** The stored record's `lastUpdated` — what the sync's GET hands the client. */
const L1 = "2026-03-01T11:00:00.000Z";
/** Pinned clock: the `lastUpdated` the next PATCH / PUT writes. */
const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const L2 = new Date(NOW).toISOString();
const HOUR_BUCKET = Math.floor(NOW / 3_600_000);
const PUT_BOOKS_COUNTER = `ratelimit:user:put-books:${USER1}:${HOUR_BUCKET}`;

const BOOK_A = "210439468000101";
const BOOK_B = "210439468000102";

const SHELF_ID = "11111111-1111-4111-8111-111111111111";
const SHARE_TOKEN = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

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

function send(method: string, body?: unknown): Promise<Response> {
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
    app.request(PATH, init, { KV: kv, ...rateLimitBindings() }),
  );
}

/** Seed `user:{USER1}` with book A shared, stamped `lastUpdated` = L1. */
async function seedRecord(): Promise<void> {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId: USER1,
    displayName: "Alice",
    books: [book(BOOK_A, BoolFlag.TRUE)],
    lastUpdated: L1,
  };
  await kv.put(kvKeys.user(USER1), JSON.stringify(record));
}

/** A live, migrated public shelf with its snapshot already published. */
async function seedPublicShelf(): Promise<void> {
  const shelf: PublicShelf = {
    shelfId: SHELF_ID,
    shareToken: SHARE_TOKEN,
    title: "公開書櫃",
    expiresDays: null,
    createdAt: Date.parse(L1),
    expiresAt: null,
    selectionMode: "all-shared",
  };
  const pointer: PublicShelvesRecord = { shelves: [shelf] };
  await kv.put(kvKeys.publicShelves(USER1), JSON.stringify(pointer));
  await writePublicSnapshot(kv, USER1, shelf, [book(BOOK_A, BoolFlag.TRUE)]);
}

function storedRecord(): Promise<UserBooksRecord | null> {
  return kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
}

async function storedSharedFlag(bookId: string): Promise<BoolFlag | undefined> {
  const record = await storedRecord();
  return record?.books.find((b) => b.bookId === bookId)?.isShared;
}

async function expectError(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const json = (await res.json()) as Json;
  expect(json.error.code).toBe(code);
}

beforeEach(async () => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  token = await seedAuthToken(kv, USER1);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PUT /api/user/:id/books — #249 regression: sync PUT after a mid-sync save", () => {
  it("refuses the stale sync PUT, keeps the mid-sync unshare, then accepts the re-read value", async () => {
    await seedRecord();

    // 1. Sync GET reads L1.
    const getRes = await send("GET");
    const read = (await getRes.json()) as Json;
    expect(read.data.lastUpdated).toBe(L1);

    // 2. Mid-sync save: the user unshares book A.
    const patchRes = await send("PATCH", {
      changes: [{ bookId: BOOK_A, isShared: BoolFlag.FALSE }],
    });
    expect(patchRes.status).toBe(200);
    expect(await storedSharedFlag(BOOK_A)).toBe(BoolFlag.FALSE);

    // 3. The sync's merged PUT still carries A shared and the stale L1.
    const stalePut = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.TRUE)],
      expectedLastUpdated: L1,
    });
    await expectError(stalePut, 409, "BOOKS_CONFLICT");
    expect(await storedSharedFlag(BOOK_A)).toBe(BoolFlag.FALSE);

    // 4. Re-read gives the PATCH's stamp; a PUT echoing it goes through.
    const reread = (await (await send("GET")).json()) as Json;
    expect(reread.data.lastUpdated).toBe(L2);

    vi.setSystemTime(NOW + 60_000);
    const freshPut = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE), book(BOOK_B, BoolFlag.TRUE)],
      expectedLastUpdated: L2,
    });
    expect(freshPut.status).toBe(200);
    const stored = await storedRecord();
    expect(stored?.lastUpdated).toBe(new Date(NOW + 60_000).toISOString());
    expect(stored?.books.map((b) => [b.bookId, b.isShared])).toEqual([
      [BOOK_A, BoolFlag.FALSE],
      [BOOK_B, BoolFlag.TRUE],
    ]);
  });
});

describe("PUT /api/user/:id/books — malformed expectedLastUpdated", () => {
  it.each<{ label: string; value: unknown }>([
    { label: "a number", value: Date.parse(L1) },
    { label: "a boolean", value: true },
    { label: "an object", value: { lastUpdated: L1 } },
    { label: "an array", value: [L1] },
    { label: "a 65-character string", value: "x".repeat(65) },
  ])("answers 400 INVALID_FIELDS for $label", async ({ value }) => {
    await seedRecord();

    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE)],
      expectedLastUpdated: value,
    });

    await expectError(res, 400, "INVALID_FIELDS");
    expect(await storedSharedFlag(BOOK_A)).toBe(BoolFlag.TRUE);
  });

  it("charges the put-books counter but never reads the user record", async () => {
    await seedRecord();
    const ops = watchKvOps(kv);

    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE)],
      expectedLastUpdated: 42,
    });

    await expectError(res, 400, "INVALID_FIELDS");
    expect(ops.getKeys()).toEqual([kvKeys.authToken(token), PUT_BOOKS_COUNTER]);
    expect(ops.writeTrail()).toEqual([`put ${PUT_BOOKS_COUNTER}`]);
  });
});

describe("PUT /api/user/:id/books — precondition mismatch", () => {
  it.each<{ label: string; value: string }>([
    { label: "an older stamp", value: "2026-03-01T10:00:00.000Z" },
    // Strict string equality: the same instant spelled differently still conflicts.
    {
      label: "the same instant without milliseconds",
      value: "2026-03-01T11:00:00Z",
    },
    { label: "a 64-character string", value: "x".repeat(64) },
    { label: "a single space", value: " " },
  ])("answers 409 BOOKS_CONFLICT for $label", async ({ value }) => {
    await seedRecord();

    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE)],
      expectedLastUpdated: value,
    });

    await expectError(res, 409, "BOOKS_CONFLICT");
    const stored = await storedRecord();
    expect(stored?.lastUpdated).toBe(L1);
    expect(stored?.books[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("answers with the code the Extension sync retries on", async () => {
    await seedRecord();

    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE)],
      expectedLastUpdated: "2026-03-01T10:00:00.000Z",
    });

    expect(res.status).toBe(409);
    const json = (await res.json()) as Json;
    // Parity with shared/ catches a one-sided rename; the literal pins the wire
    // value deployed Extensions compare against, so a two-sided rename fails too.
    expect(json.error.code).toBe(BOOKS_CONFLICT_CODE);
    expect(json.error.code).toBe("BOOKS_CONFLICT");
  });

  it("answers 409 when no record exists and does not create one", async () => {
    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.TRUE)],
      expectedLastUpdated: L1,
    });

    await expectError(res, 409, "BOOKS_CONFLICT");
    expect(await storedRecord()).toBeNull();
  });

  it("writes neither the user record nor a public snapshot on 409", async () => {
    await seedRecord();
    await seedPublicShelf();
    const snapshotBefore = await kv.get(kvKeys.publicShelf(SHARE_TOKEN));
    const ops = watchKvOps(kv);

    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE)],
      expectedLastUpdated: "2026-03-01T10:00:00.000Z",
    });

    await expectError(res, 409, "BOOKS_CONFLICT");
    // The handler's reads still happen; only the counter charge is written.
    expect(ops.getKeys()).toEqual([
      kvKeys.authToken(token),
      PUT_BOOKS_COUNTER,
      kvKeys.user(USER1),
      kvKeys.member(USER1),
      kvKeys.publicShelves(USER1),
    ]);
    expect(ops.writeTrail()).toEqual([`put ${PUT_BOOKS_COUNTER}`]);
    expect(await kv.get(kvKeys.publicShelf(SHARE_TOKEN))).toBe(snapshotBefore);
  });
});

describe("PUT /api/user/:id/books — precondition match", () => {
  it("saves and refreshes the public snapshot when the value matches", async () => {
    await seedRecord();
    await seedPublicShelf();
    const ops = watchKvOps(kv);

    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE), book(BOOK_B, BoolFlag.TRUE)],
      expectedLastUpdated: L1,
    });

    expect(res.status).toBe(200);
    // Positive companion of the 409 trail: same seed, both writes land here.
    expect(ops.writeTrail()).toEqual([
      `put ${PUT_BOOKS_COUNTER}`,
      `put ${kvKeys.user(USER1)}`,
      `put ${kvKeys.publicShelf(SHARE_TOKEN)}`,
    ]);
    const stored = await storedRecord();
    expect(stored?.lastUpdated).toBe(L2);
    expect(stored?.books.map((b) => b.bookId)).toEqual([BOOK_A, BOOK_B]);
  });

  it("never persists or echoes expectedLastUpdated", async () => {
    await seedRecord();

    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.FALSE)],
      expectedLastUpdated: L1,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect("expectedLastUpdated" in json.data).toBe(false);
    const raw = await kv.get(kvKeys.user(USER1));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("expectedLastUpdated");
  });
});

describe("PUT /api/user/:id/books — no precondition supplied", () => {
  it.each<{ label: string; extra: Record<string, unknown> }>([
    { label: "null", extra: { expectedLastUpdated: null } },
    { label: "the empty string", extra: { expectedLastUpdated: "" } },
  ])(
    "treats $label as absent and overwrites a record with any lastUpdated",
    async ({ extra }) => {
      await seedRecord();

      const res = await send("PUT", {
        books: [book(BOOK_A, BoolFlag.FALSE)],
        ...extra,
      });

      expect(res.status).toBe(200);
      const stored = await storedRecord();
      expect(stored?.lastUpdated).toBe(L2);
      expect(stored?.books[0].isShared).toBe(BoolFlag.FALSE);
      expect(JSON.stringify(stored)).not.toContain("expectedLastUpdated");
    },
  );

  it("creates a first record when null is sent and none exists", async () => {
    const res = await send("PUT", {
      books: [book(BOOK_A, BoolFlag.TRUE)],
      expectedLastUpdated: null,
    });

    expect(res.status).toBe(200);
    expect((await storedRecord())?.lastUpdated).toBe(L2);
  });
});
