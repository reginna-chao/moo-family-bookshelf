/**
 * Regression suite for the public read's current-sharing filter (#461).
 *
 * The bug it exists to prevent: a books save writes `user:{id}` first and the
 * `public:{token}` snapshot second, with no transaction, and the public read
 * used to serve the snapshot's books as they stood. So a book the owner had
 * un-shared stayed on the public link in two reachable states: the snapshot
 * write failed (the API answered 500) or two saves interleaved and the older
 * snapshot landed last (both answered 200). The stored snapshot is STILL wrong
 * in both; the read now serves a snapshot book only while the owner's current
 * record has that bookId with `isShared === BoolFlag.TRUE`.
 *
 * The rule, and the sections below:
 *
 * - §1, the two reachable states, driven through the real save handlers. Each
 *   case asserts in this order that the stored snapshot still holds the book
 *   (so the state really was reached), that the response does not, and that a
 *   still-shared book IS served (so an empty or refused response cannot pass).
 *   `failFirstWriteTo` drives the failed write. `holdFirstPutTo` drives the
 *   interleaving deterministically: the second save starts only once the first
 *   save's snapshot put is held, and that put lands only after the second save
 *   has finished.
 * - §2, side-effect freedom: an anonymous reader can never drive a KV write, on
 *   any path. `DEV_MODE` keeps the per-IP counter out, so the trail is the
 *   handler's own (see `watchKvOps`). The positive companion proves the same
 *   watcher does see a snapshot put and a snapshot delete, so the negative
 *   assertions cannot pass because the selector drifted.
 * - §3, read cost: the exact read trail per path, from
 *   docs/architecture.md → 公開書櫃的寫入與撤銷. Reads are sequential so a migrated
 *   owner's dead token never pays to parse a large books record; an un-migrated
 *   owner's list fallback has already read it, and that record is handed on
 *   rather than read twice.
 * - §4, a live shelf whose books record is unusable answers byte-identically to
 *   an unknown token, so the response discloses nothing about the account.
 * - §5, the decision table, one row per cell and for both owner kinds. Every
 *   hiding row carries a control book in the same snapshot that IS served. Its
 *   companion describe pins that the filter does not depend on the shelf's
 *   expiry, and that an empty record means nothing is shared: 200 with an empty
 *   list, not 404 (there the only snapshot book is the one hidden, so no control).
 * - §6, the URL scrub still runs on what the filter keeps. The record's own URLs
 *   are clean, so a handler answering from the record instead of the snapshot
 *   fails here too.
 *
 * Fixtures: Snapshots are seeded directly, except in §1 and the §2 companion,
 * where the write path itself is under test. The mock KV is a single consistent
 * store, so the ~60s cross-colo residuals in the rule cannot be reproduced here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type PublicShelf,
  type PublicShelfSnapshot,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { writePublicSnapshot } from "../../src/services/publicShelf";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER = ALICE;
const SHELF_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const ROTATED_TOKEN = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const UNKNOWN_TOKEN = "0".repeat(32);
const SHELF_TITLE = "我的公開書櫃";
const CREATED_AT = Date.parse("2026-02-01T00:00:00.000Z");
const SEEDED_AT = "2026-02-01T00:00:00.000Z";

/** The book a case expects hidden. */
const HIDDEN_BOOK = "210439468000111";
/** The still-shared control that must be served beside it. */
const CONTROL_BOOK = "210439468000112";
const EXTRA_BOOK = "210439468000113";

let kv: KVNamespace;
let authToken: string;

/** `async` so the tables below can type their calls as `Promise<Response>`. */
async function request(
  method: string,
  path: string,
  opts?: { body?: string; token?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts?.body) init.body = opts.body;
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

// ── Fixtures ──────────────────────────────────────────────────

function makeBook(bookId: string, isShared: BoolFlag): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: `Author ${bookId}`,
    isbn: `isbn-${bookId}`,
    coverUrl: `https://cdn.readmoo.com/${bookId}.jpg`,
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "fiction",
    isShared,
  };
}

function shelf(
  shareToken = TOKEN,
  expiresAt: number | null = null,
): PublicShelf {
  return {
    shelfId: SHELF_ID,
    shareToken,
    title: SHELF_TITLE,
    expiresDays: expiresAt === null ? null : 7,
    createdAt: CREATED_AT,
    expiresAt,
    selectionMode: "all-shared",
  };
}

// ── Seeding ───────────────────────────────────────────────────

type OwnerKind = "migrated" | "un-migrated";

const OWNER_KINDS: { owner: OwnerKind }[] = [
  { owner: "migrated" },
  { owner: "un-migrated" },
];

async function seedPointer(shelves: PublicShelf[] = [shelf()]): Promise<void> {
  const record: PublicShelvesRecord = { shelves };
  await kv.put(kvKeys.publicShelves(USER), JSON.stringify(record));
}

/** Seed `user:{USER}` from raw fields, so a case can store what no writer would. */
async function seedRecord(fields: Record<string, unknown>): Promise<void> {
  await kv.put(
    kvKeys.user(USER),
    JSON.stringify({
      schemaVersion: 1,
      userId: USER,
      displayName: "Test User",
      lastUpdated: SEEDED_AT,
      ...fields,
    }),
  );
}

/** Seed the owner's books and shelf list: pointer key, or the legacy field only. */
async function seedOwner(
  owner: OwnerKind,
  books: unknown,
  shelves: PublicShelf[] = [shelf()],
): Promise<void> {
  if (owner === "migrated") {
    await seedPointer(shelves);
    await seedRecord({ books });
    return;
  }
  await seedRecord({ books, publicSharing: { shelves } });
}

/** Seed a snapshot DIRECTLY, bypassing the writer's shared-only filter and URL scrub. */
async function seedSnapshotBooks(
  books: BookEntry[],
  opts?: { token?: string; expiresAt?: number | null },
): Promise<void> {
  const snapshot: PublicShelfSnapshot = {
    userId: USER,
    shelfId: SHELF_ID,
    title: SHELF_TITLE,
    books,
    createdAt: CREATED_AT,
    expiresAt: opts?.expiresAt ?? null,
  };
  await kv.put(
    kvKeys.publicShelf(opts?.token ?? TOKEN),
    JSON.stringify(snapshot),
  );
}

// ── Readers and requests ──────────────────────────────────────

async function storedSnapshotBookIds(): Promise<string[] | undefined> {
  const snapshot = await kv.get<PublicShelfSnapshot>(
    kvKeys.publicShelf(TOKEN),
    "json",
  );
  return snapshot?.books.map((b) => b.bookId);
}

async function storedSharedFlag(bookId: string): Promise<unknown> {
  const record = await kv.get<UserBooksRecord>(kvKeys.user(USER), "json");
  return record?.books.find((b) => b.bookId === bookId)?.isShared;
}

function publicRead(token = TOKEN): Promise<Response> {
  return request("GET", `/api/public/${token}`);
}

/** The bookIds a 200 public read serves. */
async function servedBookIds(): Promise<string[]> {
  const res = await publicRead();
  expect(res.status).toBe(200);
  const json = (await res.json()) as Json;
  return json.data.books.map((b: Json) => b.bookId);
}

function putBooks(books: BookEntry[]): Promise<Response> {
  return request("PUT", `/api/user/${USER}/books`, {
    body: JSON.stringify({
      schemaVersion: 1,
      userId: USER,
      displayName: "Test User",
      books,
    }),
    token: authToken,
  });
}

function patchBook(bookId: string, isShared: BoolFlag): Promise<Response> {
  return request("PATCH", `/api/user/${USER}/books`, {
    body: JSON.stringify({ changes: [{ bookId, isShared }] }),
    token: authToken,
  });
}

/** Set HIDDEN_BOOK's flag through either save endpoint, CONTROL_BOOK staying shared. */
const BOOKS_SAVES: {
  label: string;
  setHiddenBook: (isShared: BoolFlag) => Promise<Response>;
}[] = [
  {
    label: "PUT",
    setHiddenBook: (isShared) =>
      putBooks([
        makeBook(HIDDEN_BOOK, isShared),
        makeBook(CONTROL_BOOK, BoolFlag.TRUE),
      ]),
  },
  {
    label: "PATCH",
    setHiddenBook: (isShared) => patchBook(HIDDEN_BOOK, isShared),
  },
];

/** Hold the FIRST `put` on `key` until `release()`, other calls passing through; `intercepted`
 *  resolves once it is reached. Restored by `vi.restoreAllMocks()`, like `failFirstWriteTo`. */
function holdFirstPutTo(
  store: KVNamespace,
  key: string,
): { intercepted: Promise<void>; release: () => void } {
  const realPut = store.put.bind(store) as (
    ...args: unknown[]
  ) => Promise<void>;
  let markIntercepted = (): void => {};
  const intercepted = new Promise<void>((resolve) => {
    markIntercepted = resolve;
  });
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  vi.spyOn(store, "put").mockImplementation((async (...args: unknown[]) => {
    if (args[0] === key && !held) {
      held = true;
      markIntercepted();
      await released;
    }
    return realPut(...args);
  }) as never);
  return { intercepted, release };
}

/** Assert a public read was refused byte-identically to a never-existing token. */
async function expectAnsweredLikeUnknownToken(res: Response): Promise<void> {
  const unknown = await publicRead(UNKNOWN_TOKEN);

  expect(res.status).toBe(404);
  expect(res.status).toBe(unknown.status);
  expect(res.headers.get("content-type")).toBe(
    unknown.headers.get("content-type"),
  );
  const body = await res.text();
  expect(body).toBe(await unknown.text());
  expect(JSON.parse(body).error.code).toBe("PUBLIC_SHELF_NOT_FOUND");
  expect(body).not.toContain(SHELF_TITLE);
}

beforeEach(async () => {
  kv = createMockKV();
  authToken = await seedAuthToken(kv, USER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. The two reachable states ───────────────────────────────
// See the header → "§1, the two reachable states".

describe("GET /api/public/:shareToken — a book un-shared while the snapshot still holds it", () => {
  it.each(BOOKS_SAVES)(
    "hides it after a $label save whose snapshot write failed",
    async ({ setHiddenBook }) => {
      const books = [
        makeBook(HIDDEN_BOOK, BoolFlag.TRUE),
        makeBook(CONTROL_BOOK, BoolFlag.TRUE),
      ];
      await seedOwner("migrated", books);
      await writePublicSnapshot(kv, USER, shelf(), books);
      failFirstWriteTo(kv, "put", kvKeys.publicShelf(TOKEN));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await setHiddenBook(BoolFlag.FALSE);

      expect(res.status).toBe(500);
      expect(await storedSharedFlag(HIDDEN_BOOK)).toBe(BoolFlag.FALSE);
      expect(await storedSnapshotBookIds()).toContain(HIDDEN_BOOK);
      expect(await servedBookIds()).toEqual([CONTROL_BOOK]);
    },
  );

  it.each(BOOKS_SAVES)(
    "hides it after two interleaved $label saves leave the older snapshot on top",
    async ({ setHiddenBook }) => {
      const books = [
        makeBook(HIDDEN_BOOK, BoolFlag.FALSE),
        makeBook(CONTROL_BOOK, BoolFlag.TRUE),
      ];
      await seedOwner("migrated", books);
      await writePublicSnapshot(kv, USER, shelf(), books);
      const held = holdFirstPutTo(kv, kvKeys.publicShelf(TOKEN));

      const sharing = setHiddenBook(BoolFlag.TRUE);
      await held.intercepted;
      const unsharing = await setHiddenBook(BoolFlag.FALSE);
      held.release();
      const shared = await sharing;

      expect(shared.status).toBe(200);
      expect(unsharing.status).toBe(200);
      expect(await storedSharedFlag(HIDDEN_BOOK)).toBe(BoolFlag.FALSE);
      expect(await storedSnapshotBookIds()).toContain(HIDDEN_BOOK);
      expect(await servedBookIds()).toEqual([CONTROL_BOOK]);
    },
  );
});

// ── Every path through the handler (§2 and §3) ────────────────

const SHARED_BOOKS = [makeBook(CONTROL_BOOK, BoolFlag.TRUE)];
const EXPIRED_AT = CREATED_AT;

const READ_PATHS: {
  label: string;
  token: string;
  seed: () => Promise<void>;
  status: 200 | 404;
  trail: () => string[];
}[] = [
  {
    label: "an unknown token",
    token: UNKNOWN_TOKEN,
    seed: () => Promise.resolve(),
    status: 404,
    trail: () => [kvKeys.publicShelf(UNKNOWN_TOKEN)],
  },
  {
    label: "an expired snapshot",
    token: TOKEN,
    seed: async () => {
      await seedOwner("migrated", SHARED_BOOKS, [shelf(TOKEN, EXPIRED_AT)]);
      await seedSnapshotBooks(SHARED_BOOKS, { expiresAt: EXPIRED_AT });
    },
    status: 404,
    trail: () => [kvKeys.publicShelf(TOKEN)],
  },
  {
    label: "a migrated owner's token the list no longer carries",
    token: TOKEN,
    seed: async () => {
      await seedOwner("migrated", SHARED_BOOKS, [shelf(ROTATED_TOKEN)]);
      await seedSnapshotBooks(SHARED_BOOKS);
    },
    status: 404,
    trail: () => [kvKeys.publicShelf(TOKEN), kvKeys.publicShelves(USER)],
  },
  {
    label: "an un-migrated owner's token the list no longer carries",
    token: TOKEN,
    seed: async () => {
      await seedOwner("un-migrated", SHARED_BOOKS, [shelf(ROTATED_TOKEN)]);
      await seedSnapshotBooks(SHARED_BOOKS);
    },
    status: 404,
    trail: () => [
      kvKeys.publicShelf(TOKEN),
      kvKeys.publicShelves(USER),
      kvKeys.user(USER),
    ],
  },
  {
    label: "a live shelf with no books record",
    token: TOKEN,
    seed: async () => {
      await seedPointer();
      await seedSnapshotBooks(SHARED_BOOKS);
    },
    status: 404,
    trail: () => [
      kvKeys.publicShelf(TOKEN),
      kvKeys.publicShelves(USER),
      kvKeys.accountDeleting(USER),
      kvKeys.user(USER),
    ],
  },
  {
    label: "a migrated owner's live shelf",
    token: TOKEN,
    seed: async () => {
      await seedOwner("migrated", SHARED_BOOKS);
      await seedSnapshotBooks(SHARED_BOOKS);
    },
    status: 200,
    trail: () => [
      kvKeys.publicShelf(TOKEN),
      kvKeys.publicShelves(USER),
      kvKeys.accountDeleting(USER),
      kvKeys.user(USER),
    ],
  },
  {
    label: "an un-migrated owner's live shelf",
    token: TOKEN,
    seed: async () => {
      await seedOwner("un-migrated", SHARED_BOOKS);
      await seedSnapshotBooks(SHARED_BOOKS);
    },
    status: 200,
    trail: () => [
      kvKeys.publicShelf(TOKEN),
      kvKeys.publicShelves(USER),
      kvKeys.user(USER),
      kvKeys.accountDeleting(USER),
    ],
  },
];

// ── 2. Side-effect freedom ────────────────────────────────────
// See the header → "§2, side-effect freedom".

describe("GET /api/public/:shareToken — KV writes", () => {
  it.each(READ_PATHS)(
    "writes nothing for $label",
    async ({ token, seed, status }) => {
      await seed();
      const ops = watchKvOps(kv);

      const res = await publicRead(token);

      expect(res.status).toBe(status);
      expect(ops.putKeys()).toEqual([]);
      expect(ops.deleteKeys()).toEqual([]);
    },
  );

  it("sees a snapshot put and a snapshot delete through the same watcher when a write handler runs", async () => {
    const books = [
      makeBook(HIDDEN_BOOK, BoolFlag.TRUE),
      makeBook(CONTROL_BOOK, BoolFlag.TRUE),
    ];
    await seedOwner("migrated", books);
    await writePublicSnapshot(kv, USER, shelf(), books);
    const ops = watchKvOps(kv);

    const saved = await putBooks(books);
    const deleted = await request(
      "DELETE",
      `/api/user/${USER}/public-shelf/${SHELF_ID}`,
      { token: authToken },
    );

    expect(saved.status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(ops.putKeys()).toContain(kvKeys.publicShelf(TOKEN));
    expect(ops.deleteKeys()).toContain(kvKeys.publicShelf(TOKEN));
  });
});

// ── 3. Read cost ──────────────────────────────────────────────
// See the header → "§3, read cost".

describe("GET /api/public/:shareToken — read trail", () => {
  it.each(READ_PATHS)(
    "pays the documented reads for $label",
    async ({ token, seed, status, trail }) => {
      await seed();
      const ops = watchKvOps(kv);

      const res = await publicRead(token);

      expect(res.status).toBe(status);
      expect(ops.getKeys()).toEqual(trail());
    },
  );
});

// ── 4. A live shelf whose books record is unusable ────────────
// See the header → "§4, a live shelf whose books record is unusable".

describe("GET /api/public/:shareToken — unusable books record", () => {
  it("answers a live shelf with no books record exactly like an unknown token", async () => {
    await seedPointer();
    await seedSnapshotBooks(SHARED_BOOKS);

    await expectAnsweredLikeUnknownToken(await publicRead());
  });

  const CORRUPT_BOOKS: { label: string; books: unknown }[] = [
    { label: "a string", books: "corrupt" },
    { label: "null", books: null },
    { label: "an absent field", books: undefined },
    { label: "an object keyed like an array", books: { 0: SHARED_BOOKS[0] } },
  ];

  describe.each(OWNER_KINDS)("for a $owner owner", ({ owner }) => {
    it.each(CORRUPT_BOOKS)(
      "answers exactly like an unknown token when books is $label",
      async ({ books }) => {
        await seedOwner(owner, books);
        await seedSnapshotBooks(SHARED_BOOKS);

        await expectAnsweredLikeUnknownToken(await publicRead());
      },
    );
  });

  it("serves the same fixture once the record's books are a real list", async () => {
    // Control: the refusals above come from the record, not from a broken fixture.
    await seedOwner("migrated", SHARED_BOOKS);
    await seedSnapshotBooks(SHARED_BOOKS);

    expect(await servedBookIds()).toEqual([CONTROL_BOOK]);
  });
});

// ── 5. The decision table ─────────────────────────────────────
// See the header → "§5, the decision table".

describe.each(OWNER_KINDS)(
  "GET /api/public/:shareToken — decision table, $owner owner",
  ({ owner }) => {
    const controlShared = makeBook(CONTROL_BOOK, BoolFlag.TRUE);

    /** The record entry for a book, with `isShared` forced to any stored value. */
    function recordEntry(bookId: string, isShared: unknown): unknown {
      return { ...makeBook(bookId, BoolFlag.TRUE), isShared };
    }

    const HIDING_CELLS: { label: string; recordBooks: unknown[] }[] = [
      {
        label: "isShared is 0",
        recordBooks: [recordEntry(HIDDEN_BOOK, BoolFlag.FALSE), controlShared],
      },
      {
        label: "isShared is missing",
        recordBooks: [recordEntry(HIDDEN_BOOK, undefined), controlShared],
      },
      {
        label: "isShared is the boolean true",
        recordBooks: [recordEntry(HIDDEN_BOOK, true), controlShared],
      },
      {
        label: "the bookId is absent from the record",
        recordBooks: [controlShared],
      },
    ];

    it.each(HIDING_CELLS)(
      "hides a snapshot book when $label, and serves the control beside it",
      async ({ recordBooks }) => {
        await seedOwner(owner, recordBooks);
        await seedSnapshotBooks([
          makeBook(HIDDEN_BOOK, BoolFlag.TRUE),
          controlShared,
        ]);

        expect(await servedBookIds()).toEqual([CONTROL_BOOK]);
      },
    );

    it("leaves out a book shared only in the record, and serves the control", async () => {
      await seedOwner(owner, [
        makeBook(EXTRA_BOOK, BoolFlag.TRUE),
        controlShared,
      ]);
      await seedSnapshotBooks([controlShared]);

      expect(await servedBookIds()).toEqual([CONTROL_BOOK]);
    });

    it("serves a still-shared book with the snapshot's fields and order", async () => {
      const published = [
        { ...controlShared, title: "As published" },
        makeBook(EXTRA_BOOK, BoolFlag.TRUE),
      ];
      await seedOwner(owner, [
        makeBook(EXTRA_BOOK, BoolFlag.TRUE),
        { ...controlShared, title: "Since renamed" },
      ]);
      await seedSnapshotBooks(published);

      const res = await publicRead();

      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data.books).toEqual(published);
    });

    it("answers 200 with an empty list and the title intact when every book is filtered", async () => {
      await seedOwner(owner, [
        makeBook(HIDDEN_BOOK, BoolFlag.FALSE),
        makeBook(CONTROL_BOOK, BoolFlag.FALSE),
      ]);
      await seedSnapshotBooks([
        makeBook(HIDDEN_BOOK, BoolFlag.TRUE),
        controlShared,
      ]);

      const res = await publicRead();

      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data).toEqual({
        title: SHELF_TITLE,
        books: [],
        createdAt: CREATED_AT,
        expiresAt: null,
      });
    });
  },
);

// See the header → "§5, the decision table" (its companion describe).
describe.each(OWNER_KINDS)(
  "GET /api/public/:shareToken — time-limited shelf and empty record, $owner owner",
  ({ owner }) => {
    it("hides an un-shared book on a time-limited shelf, and serves the control", async () => {
      const expiresAt = Date.now() + 7 * 86_400_000;
      await seedOwner(
        owner,
        [
          makeBook(HIDDEN_BOOK, BoolFlag.FALSE),
          makeBook(CONTROL_BOOK, BoolFlag.TRUE),
        ],
        [shelf(TOKEN, expiresAt)],
      );
      await seedSnapshotBooks(
        [
          makeBook(HIDDEN_BOOK, BoolFlag.TRUE),
          makeBook(CONTROL_BOOK, BoolFlag.TRUE),
        ],
        { expiresAt },
      );

      expect(await servedBookIds()).toEqual([CONTROL_BOOK]);
    });

    it("answers 200 with an empty list when the record's books are an empty array", async () => {
      await seedOwner(owner, []);
      await seedSnapshotBooks(SHARED_BOOKS);

      expect(await servedBookIds()).toEqual([]);
    });
  },
);

// ── 6. The URL scrub still runs ───────────────────────────────
// See the header → "§6, the URL scrub still runs".

describe("GET /api/public/:shareToken — URL scrub after the filter", () => {
  const BEACON_HOST = "evil.example.com";
  const PHISHING_HOST = "phish.example.com";

  /** A book whose snapshot copy carries two URLs minted before the whitelist. */
  function poisoned(bookId: string): BookEntry {
    return {
      ...makeBook(bookId, BoolFlag.TRUE),
      coverUrl: `https://${BEACON_HOST}/beacon.gif`,
      readmooUrl: `https://${PHISHING_HOST}/login`,
    };
  }

  it("blanks a still-shared book's poisoned URLs and leaves the control's alone", async () => {
    const control = makeBook(CONTROL_BOOK, BoolFlag.TRUE);
    await seedOwner("migrated", [makeBook(EXTRA_BOOK, BoolFlag.TRUE), control]);
    await seedSnapshotBooks([poisoned(EXTRA_BOOK), control]);

    const res = await publicRead();

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body).data.books).toEqual([
      { ...poisoned(EXTRA_BOOK), coverUrl: "", readmooUrl: "" },
      control,
    ]);
    expect(body).not.toContain(BEACON_HOST);
    expect(body).not.toContain(PHISHING_HOST);
  });
});
