/**
 * Regression suite for the public-shelf POINTER key, `publicshelves:{userId}`.
 *
 * The bug it exists to prevent: while the shelf list lived inside
 * `user:{userId}`, the books hot path (`PUT`/`PATCH /api/user/:id/books`) —
 * a read-modify-write of that whole blob, with no CAS — could rewrite it from a
 * cross-colo read up to ~60s stale. A save from a second device therefore rolled
 * a revoked share token back to life and re-published a snapshot the owner had
 * just deleted or rotated away.
 *
 * The fix moves the list to its own key with a SINGLE writer domain (the four
 * public-shelf write handlers) and makes every reader resolve it pointer-first
 * (`resolvePublicShelves`), with the legacy `user:{userId}.publicSharing` field
 * kept only as a lazy-migration fallback. This file pins the five properties
 * that make that hold:
 *
 * 1. The books paths READ the pointer key and never write it, so no save can
 *    resurrect a revoked token (and the legacy field evaporates once migrated).
 * 2. `GET /api/public/:shareToken` revalidates EVERY surviving snapshot against
 *    the pointer key — same shelfId, same share token, and a deadline that does
 *    not OUTLIVE the shelf's — so even a snapshot that somehow got re-published
 *    stays unreadable.
 * 3. Migration is lazy and handler-only: an un-migrated owner behaves exactly as
 *    before until their first public-shelf write creates the key.
 * 4. The pointer key stands on its own: revocation succeeds with no
 *    `user:{userId}` record at all, and a corrupted pointer record degrades to
 *    "no shelves" rather than falling back to the legacy list or throwing.
 * 5. Revocation writes land in the ORDER that keeps a partial failure
 *    fail-closed — the pointer write, which IS the revocation, before the
 *    snapshot delete.
 *
 * The un-migrated read path also has coverage in `publicShelf.test.ts`, whose
 * liveness suite seeds exclusively through the legacy field.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import {
  BoolFlag,
  kvKeys,
  MAX_PUBLIC_SHELVES,
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
const OTHER_SHELF_ID = "22222222-2222-4222-8222-222222222222";

/** The token the POINTER key lists — the only live one. */
const LIVE_TOKEN = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
/** The token a stale LEGACY field still lists after a rotation / delete. */
const REVOKED_TOKEN = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const UNKNOWN_TOKEN = "0".repeat(32);

const SHELF_TITLE = "我的公開書櫃";
const CREATED_AT = Date.parse("2026-02-01T00:00:00.000Z");
const SEEDED_AT = "2026-02-01T00:00:00.000Z";
const DAY_MS = 86_400_000;

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

/** Seeded baseline: book1 + book3 shared, book2 private. */
function baselineBooks(): BookEntry[] {
  return [
    makeBook("book1", BoolFlag.TRUE),
    makeBook("book2", BoolFlag.FALSE),
    makeBook("book3", BoolFlag.TRUE),
  ];
}

/** The same three books after the owner unshared book1 and shared book2. */
function rotatedBooks(): BookEntry[] {
  return [
    makeBook("book1", BoolFlag.FALSE),
    makeBook("book2", BoolFlag.TRUE),
    makeBook("book3", BoolFlag.TRUE),
  ];
}

const BASELINE_SHARED_IDS = ["book1", "book3"];
const ROTATED_SHARED_IDS = ["book2", "book3"];

function shelf(
  shelfId: string,
  shareToken: string,
  expiresAt: number | null = null,
): PublicShelf {
  return {
    shelfId,
    shareToken,
    title: SHELF_TITLE,
    expiresDays: expiresAt === null ? null : 7,
    createdAt: CREATED_AT,
    expiresAt,
    selectionMode: "all-shared",
  };
}

/** A legacy shelf list already at the production cap. */
function fullLegacyList(): PublicShelf[] {
  return Array.from({ length: MAX_PUBLIC_SHELVES }, (_, i) =>
    shelf(
      `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
      i.toString(16).padStart(32, "0"),
    ),
  );
}

// ── Seeding ───────────────────────────────────────────────────

/** Seed `user:{USER}`; pass `legacyShelves` for an un-migrated shelf list. */
async function seedUser(opts?: {
  books?: BookEntry[];
  legacyShelves?: PublicShelf[];
}): Promise<void> {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId: USER,
    displayName: "Test User",
    books: opts?.books ?? baselineBooks(),
    lastUpdated: SEEDED_AT,
  };
  if (opts?.legacyShelves) {
    record.publicSharing = { shelves: opts.legacyShelves };
  }
  await kv.put(kvKeys.user(USER), JSON.stringify(record));
}

/** Seed the authoritative pointer key — the state after a migrating write. */
async function seedPointer(shelves: PublicShelf[]): Promise<void> {
  const record: PublicShelvesRecord = { shelves };
  await kv.put(kvKeys.publicShelves(USER), JSON.stringify(record));
}

/**
 * Seed a stored snapshot through the PRODUCTION writer, so its shape (shared
 * books only, TTL derived from `expiresAt`) can never drift from what the
 * handlers actually publish.
 */
function seedSnapshot(entry: PublicShelf, books = baselineBooks()) {
  return writePublicSnapshot(kv, USER, entry, books);
}

// ── Readers ───────────────────────────────────────────────────

function userRecord(): Promise<UserBooksRecord | null> {
  return kv.get<UserBooksRecord>(kvKeys.user(USER), "json");
}

function pointerRecord(): Promise<PublicShelvesRecord | null> {
  return kv.get<PublicShelvesRecord>(kvKeys.publicShelves(USER), "json");
}

function storedSnapshot(token: string): Promise<PublicShelfSnapshot | null> {
  return kv.get<PublicShelfSnapshot>(kvKeys.publicShelf(token), "json");
}

/** bookIds a stored snapshot publishes, or null when there is no snapshot. */
async function publishedBookIds(token: string): Promise<string[] | null> {
  const snapshot = await storedSnapshot(token);
  return snapshot ? snapshot.books.map((b) => b.bookId) : null;
}

// ── Requests under test ───────────────────────────────────────

function putBooks(books: BookEntry[]) {
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

/** PATCH that lands on the SAME shared set as `putBooks(rotatedBooks())`. */
function patchToRotated() {
  return request("PATCH", `/api/user/${USER}/books`, {
    body: JSON.stringify({
      changes: [
        { bookId: "book1", isShared: BoolFlag.FALSE },
        { bookId: "book2", isShared: BoolFlag.TRUE },
      ],
    }),
    token: authToken,
  });
}

/**
 * The two books-save endpoints. Both leave `ROTATED_SHARED_IDS` behind, so one
 * table can assert identical snapshot / record outcomes for either.
 */
const BOOKS_SAVES: { label: string; save: () => Promise<Response> }[] = [
  { label: "PUT", save: () => putBooks(rotatedBooks()) },
  { label: "PATCH", save: () => patchToRotated() },
];

/**
 * The two write handlers that must REBUILD a snapshot, so they read `user:{id}`
 * for `record.books` and answer 404 without it. They are also the handlers that
 * migrate an un-migrated owner while keeping the shelf, which is the other
 * property the tables below drive them for. DELETE is deliberately absent:
 * revocation rebuilds nothing, so it must not inherit the books precondition.
 */
const SNAPSHOT_REBUILDING_WRITES: {
  label: string;
  call: (shelfId: string) => Promise<Response>;
}[] = [
  {
    label: "PUT update",
    call: (shelfId) =>
      request("PUT", `/api/user/${USER}/public-shelf/${shelfId}`, {
        body: JSON.stringify({ title: "新標題" }),
        token: authToken,
      }),
  },
  {
    label: "POST reset-token",
    call: (shelfId) =>
      request("POST", `/api/user/${USER}/public-shelf/${shelfId}/reset-token`, {
        token: authToken,
      }),
  },
];

/**
 * Assert a public read was refused byte-identically to a token that never
 * existed — an orphan must not confirm that its token was ever real.
 */
async function expectAnsweredLikeUnknownToken(res: Response): Promise<void> {
  const unknown = await request("GET", `/api/public/${UNKNOWN_TOKEN}`);

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

// ── 1. The lost update itself ─────────────────────────────────

describe("Books save against a stale legacy shelf list", () => {
  it.each(BOOKS_SAVES)(
    "$label refreshes the pointer key's token and never resurrects the revoked one",
    async ({ save }) => {
      // The exact split a stale cross-colo read produces: `user:{id}` still
      // carries the pre-rotation token, the pointer key carries the live one.
      await seedUser({ legacyShelves: [shelf(SHELF_ID, REVOKED_TOKEN)] });
      await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
      const ops = watchKvOps(kv);

      const res = await save();
      expect(res.status).toBe(200);

      // The revoked token was never re-published — the whole point of the fix.
      expect(await storedSnapshot(REVOKED_TOKEN)).toBeNull();

      // The live token's snapshot did get the newly shared set.
      expect(await publishedBookIds(LIVE_TOKEN)).toEqual(ROTATED_SHARED_IDS);

      // Exactly one snapshot write, under the live token.
      expect(ops.putKeys().filter((k) => k.startsWith("public:"))).toEqual([
        kvKeys.publicShelf(LIVE_TOKEN),
      ]);

      // The books path is READ-ONLY on the pointer key...
      expect(ops.putKeys()).not.toContain(kvKeys.publicShelves(USER));
      expect(await pointerRecord()).toEqual({
        shelves: [shelf(SHELF_ID, LIVE_TOKEN)],
      });

      // ...and drops the stale legacy list from the rebuilt record, which no
      // reader consults once the pointer key exists.
      expect((await userRecord())?.publicSharing).toBeUndefined();
    },
  );

  it("ignores a legacy shelf the pointer key no longer lists at all", async () => {
    // Delete-then-recreate rather than a rotation: the legacy field names a
    // shelfId that is gone, so nothing about it may reach the snapshot writer.
    await seedUser({ legacyShelves: [shelf(OTHER_SHELF_ID, REVOKED_TOKEN)] });
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);

    const res = await putBooks(rotatedBooks());
    expect(res.status).toBe(200);

    expect(await storedSnapshot(REVOKED_TOKEN)).toBeNull();
    expect(await publishedBookIds(LIVE_TOKEN)).toEqual(ROTATED_SHARED_IDS);
  });

  it("keeps a deleted shelf deleted when a later books save carries a stale read", async () => {
    // End-to-end version, driven through the real delete handler: it empties the
    // pointer key and leaves `user:{id}` untouched, so the legacy field survives
    // as exactly the stale list a racing save would otherwise restore.
    await seedUser({ legacyShelves: [shelf(SHELF_ID, REVOKED_TOKEN)] });
    await seedSnapshot(shelf(SHELF_ID, REVOKED_TOKEN));

    const deleted = await request(
      "DELETE",
      `/api/user/${USER}/public-shelf/${SHELF_ID}`,
      { token: authToken },
    );
    expect(deleted.status).toBe(204);
    expect(await pointerRecord()).toEqual({ shelves: [] });
    expect((await userRecord())?.publicSharing?.shelves).toHaveLength(1);

    const ops = watchKvOps(kv);
    const saved = await putBooks(rotatedBooks());
    expect(saved.status).toBe(200);

    // No snapshot write of any kind, so the revoked link stays dead.
    expect(ops.putKeys().filter((k) => k.startsWith("public:"))).toEqual([]);
    expect(await storedSnapshot(REVOKED_TOKEN)).toBeNull();
    expect((await userRecord())?.publicSharing).toBeUndefined();

    // Both the owner's own list and the public link agree the shelf is gone.
    const list = await request("GET", `/api/user/${USER}/public-shelf`, {
      token: authToken,
    });
    expect(((await list.json()) as Json).data.shelves).toEqual([]);

    const publicRead = await request("GET", `/api/public/${REVOKED_TOKEN}`);
    await expectAnsweredLikeUnknownToken(publicRead);
  });
});

// ── 2. The read-side guard, for every snapshot ────────────────

describe("GET /api/public/:shareToken — liveness against the pointer key", () => {
  const GUARD_CASES: { label: string; expiresAt: () => number | null }[] = [
    { label: "permanent (expiresAt null)", expiresAt: () => null },
    {
      // The case the old permanent-only guard ADMITTED: a time-limited snapshot
      // skipped revalidation entirely and kept serving until its deadline.
      label: "time-limited with a deadline still in the future",
      expiresAt: () => Date.now() + 7 * DAY_MS,
    },
  ];

  it.each(GUARD_CASES)(
    "refuses a $label snapshot whose token the pointer key no longer lists",
    async ({ expiresAt }) => {
      const deadline = expiresAt();
      await seedUser();
      await seedPointer([shelf(SHELF_ID, LIVE_TOKEN, deadline)]);
      // Both snapshots survive; only the pointer key says which is real.
      await seedSnapshot(shelf(SHELF_ID, REVOKED_TOKEN, deadline));
      await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN, deadline));

      const revoked = await request("GET", `/api/public/${REVOKED_TOKEN}`);
      await expectAnsweredLikeUnknownToken(revoked);

      // Control: the token the pointer key does list is served normally, so the
      // 404 above is the guard and not a broken fixture.
      const live = await request("GET", `/api/public/${LIVE_TOKEN}`);
      expect(live.status).toBe(200);
      expect(((await live.json()) as Json).data.title).toBe(SHELF_TITLE);
    },
  );

  it("reads the snapshot and the pointer key only for a migrated owner", async () => {
    // Read-cost tripwire. `user:{id}` is seeded and would satisfy the guard on
    // its own, so only the read trail catches a handler that keeps consulting it
    // — one needless KV read on every public hit.
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));
    const ops = watchKvOps(kv);

    const res = await request("GET", `/api/public/${LIVE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(ops.getKeys()).toEqual([
      kvKeys.publicShelf(LIVE_TOKEN),
      kvKeys.publicShelves(USER),
    ]);
    // Strictly side-effect free: a stranger can never drive a KV write.
    expect(ops.putKeys()).toEqual([]);
    expect(ops.deleteKeys()).toEqual([]);
  });

  it("adds exactly one user:{id} read for an un-migrated owner", async () => {
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));
    const ops = watchKvOps(kv);

    const res = await request("GET", `/api/public/${LIVE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(ops.getKeys()).toEqual([
      kvKeys.publicShelf(LIVE_TOKEN),
      kvKeys.publicShelves(USER),
      kvKeys.user(USER),
    ]);
  });
});

// ── 3. expiresAt is MONOTONIC, without false 404s ─────────────

describe("GET /api/public/:shareToken — expiresAt vs the shelf's", () => {
  /** Create a real time-limited shelf and return it. */
  async function createTimedShelf(expiresDays: number): Promise<Json> {
    await seedUser();
    const res = await request("POST", `/api/user/${USER}/public-shelf`, {
      body: JSON.stringify({ title: SHELF_TITLE, expiresDays }),
      token: authToken,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as Json).data.shelf;
  }

  it("serves a freshly created time-limited shelf", async () => {
    const created = await createTimedShelf(30);

    const res = await request("GET", `/api/public/${created.shareToken}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.expiresAt).toBe(created.expiresAt);
  });

  it("keeps serving after an expiresDays update moves the deadline", async () => {
    // Shelf and snapshot are rewritten by the same handler call, so both
    // deadlines stay equal — the regression this guards is a guard that 404s
    // the owner's own shelf right after they edited it.
    const created = await createTimedShelf(30);

    const updated = await request(
      "PUT",
      `/api/user/${USER}/public-shelf/${created.shelfId}`,
      { body: JSON.stringify({ expiresDays: 90 }), token: authToken },
    );
    expect(updated.status).toBe(200);
    const shelfAfter = ((await updated.json()) as Json).data.shelf;
    expect(shelfAfter.expiresAt).not.toBe(created.expiresAt);

    const res = await request("GET", `/api/public/${created.shareToken}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.expiresAt).toBe(
      shelfAfter.expiresAt,
    );
  });

  it("keeps serving after a title-only update leaves the deadline alone", async () => {
    const created = await createTimedShelf(30);

    const updated = await request(
      "PUT",
      `/api/user/${USER}/public-shelf/${created.shelfId}`,
      { body: JSON.stringify({ title: "新標題" }), token: authToken },
    );
    expect(updated.status).toBe(200);

    const res = await request("GET", `/api/public/${created.shareToken}`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.title).toBe("新標題");
    expect(json.data.expiresAt).toBe(created.expiresAt);
  });

  /**
   * Every way a snapshot's deadline can relate to the shelf backing it, and
   * what the MONOTONIC liveness rule answers (`null` = permanent = +∞).
   *
   * The asymmetry IS the rule: a snapshot may never promise a LONGER lifetime
   * than the shelf currently grants — that is the only direction that hands out
   * more access than the owner allowed — while promising a SHORTER one is
   * harmless and stays readable until its own earlier deadline.
   */
  const EXPIRY_CASES: {
    label: string;
    shelfExpiresAt: () => number | null;
    snapshotExpiresAt: () => number | null;
    status: 200 | 404;
  }[] = [
    {
      // Snapshot promises less than an infinite shelf ⇒ nothing to refuse.
      label: "a permanent shelf backs a time-limited snapshot",
      shelfExpiresAt: () => null,
      snapshotExpiresAt: () => Date.now() + 7 * DAY_MS,
      status: 200,
    },
    {
      // The dangerous direction taken to its extreme: no KV TTL and no deadline
      // would ever retire this snapshot, so it outlives the limit the owner has
      // since imposed on the shelf.
      label: "a time-limited shelf backs a permanent snapshot",
      shelfExpiresAt: () => Date.now() + 7 * DAY_MS,
      snapshotExpiresAt: () => null,
      status: 404,
    },
    {
      // Same direction, finite: the state left behind when an update SHORTENED
      // the shelf's deadline but its snapshot rewrite failed.
      label: "the snapshot's deadline is LATER than the shelf's",
      shelfExpiresAt: () => Date.now() + 7 * DAY_MS,
      snapshotExpiresAt: () => Date.now() + 7 * DAY_MS + 60_000,
      status: 404,
    },
    {
      // The deliberate FAIL-SAFE direction, and the reason the rule is not
      // strict equality: this is exactly what an EXTEND-deadline race leaves
      // behind — a snapshot republished from a ~60s-stale pointer read just
      // after the owner pushed the deadline out. Strict equality 404'd a live
      // link at the moment its owner granted MORE access; it now keeps serving
      // and simply retires at the earlier deadline it carries.
      label: "the snapshot's deadline is EARLIER than the shelf's",
      shelfExpiresAt: () => Date.now() + 30 * DAY_MS,
      snapshotExpiresAt: () => Date.now() + 7 * DAY_MS,
      status: 200,
    },
  ];

  it.each(EXPIRY_CASES)(
    "answers $status when $label",
    async ({ shelfExpiresAt, snapshotExpiresAt, status }) => {
      // Every deadline here is in the future, so the `expiresAt` backstop admits
      // the snapshot and only the liveness comparison can refuse it.
      const snapshotDeadline = snapshotExpiresAt();
      await seedUser();
      await seedPointer([shelf(SHELF_ID, LIVE_TOKEN, shelfExpiresAt())]);
      await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN, snapshotDeadline));

      const res = await request("GET", `/api/public/${LIVE_TOKEN}`);

      if (status === 404) {
        await expectAnsweredLikeUnknownToken(res);
        return;
      }

      expect(res.status).toBe(200);
      const json = (await res.json()) as Json;
      expect(json.data.title).toBe(SHELF_TITLE);
      // Served with its OWN deadline, never the shelf's: a shorter-lived
      // snapshot is admitted, not silently extended.
      expect(json.data.expiresAt).toBe(snapshotDeadline);
    },
  );

  it("keeps serving a link whose snapshot a stale read left at the pre-extension deadline", async () => {
    // The fail-safe row above, driven end to end: the owner extends 30 → 90
    // days (the pointer key now carries the later deadline), then a books save
    // running on a stale cross-colo read of the shelf list republishes the
    // snapshot with the OLD deadline. The republish goes through the production
    // writer, so the snapshot is byte-identical to what such a save produces.
    const created = await createTimedShelf(30);

    const extended = await request(
      "PUT",
      `/api/user/${USER}/public-shelf/${created.shelfId}`,
      { body: JSON.stringify({ expiresDays: 90 }), token: authToken },
    );
    expect(extended.status).toBe(200);
    expect(
      ((await extended.json()) as Json).data.shelf.expiresAt,
    ).toBeGreaterThan(created.expiresAt);

    await seedSnapshot(
      shelf(created.shelfId, created.shareToken, created.expiresAt),
    );

    const res = await request("GET", `/api/public/${created.shareToken}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.expiresAt).toBe(created.expiresAt);
  });
});

// ── 4. Lazy migration ─────────────────────────────────────────

describe("Lazy migration to the pointer key", () => {
  it("serves an un-migrated owner's legacy shelves through both read paths", async () => {
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));

    const list = await request("GET", `/api/user/${USER}/public-shelf`, {
      token: authToken,
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as Json).data.shelves).toEqual([
      shelf(SHELF_ID, LIVE_TOKEN),
    ]);

    const publicRead = await request("GET", `/api/public/${LIVE_TOKEN}`);
    expect(publicRead.status).toBe(200);

    // Reading never migrates: the key appears on a WRITE and nowhere else.
    expect(await pointerRecord()).toBeNull();
  });

  it.each(SNAPSHOT_REBUILDING_WRITES)(
    "$label creates the pointer key and leaves user:{id} byte-unchanged",
    async ({ call }) => {
      await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
      const recordBefore = await kv.get(kvKeys.user(USER));

      const res = await call(SHELF_ID);
      expect(res.status).toBe(200);

      const migrated = await pointerRecord();
      expect(migrated?.shelves).toHaveLength(1);
      expect(migrated?.shelves[0].shelfId).toBe(SHELF_ID);

      // `user:{id}` is not a shelf-list writer anymore — not even to clean up
      // the field it just superseded.
      expect(await kv.get(kvKeys.user(USER))).toBe(recordBefore);
    },
  );

  it("revokes an un-migrated owner's legacy shelf and migrates the pointer key", async () => {
    // The third migrating write, and the ONLY delete branch the pointer-first
    // read path added: revocation resolves the shelf list through
    // `readPublicShelves`, so an un-migrated owner can only reach their shelf
    // via its `user:{id}` fallback. Without this pin, removing that fallback
    // would leave such owners unable to revoke a still-readable link while
    // every other test stayed green.
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));
    expect(await pointerRecord()).toBeNull();

    const res = await request(
      "DELETE",
      `/api/user/${USER}/public-shelf/${SHELF_ID}`,
      { token: authToken },
    );

    expect(res.status).toBe(204);
    expect(await storedSnapshot(LIVE_TOKEN)).toBeNull();
    // The revoke itself migrated: an empty list is the MIGRATED "no shelves"
    // state and outranks the stale legacy field the record still carries, so
    // no later books save can re-list the shelf.
    expect(await pointerRecord()).toEqual({ shelves: [] });
    expect((await userRecord())?.publicSharing?.shelves).toHaveLength(1);

    // Dead for readers, not merely delisted for the owner.
    const publicRead = await request("GET", `/api/public/${LIVE_TOKEN}`);
    await expectAnsweredLikeUnknownToken(publicRead);
  });

  it("drops the superseded legacy field on the next books save", async () => {
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    const migrating = await request(
      "PUT",
      `/api/user/${USER}/public-shelf/${SHELF_ID}`,
      { body: JSON.stringify({ title: "新標題" }), token: authToken },
    );
    expect(migrating.status).toBe(200);
    expect((await userRecord())?.publicSharing?.shelves).toHaveLength(1);

    const saved = await putBooks(rotatedBooks());
    expect(saved.status).toBe(200);

    expect((await userRecord())?.publicSharing).toBeUndefined();
    // The shelf survives — it just lives in the pointer key now.
    expect((await pointerRecord())?.shelves).toHaveLength(1);
    expect(await publishedBookIds(LIVE_TOKEN)).toEqual(ROTATED_SHARED_IDS);
  });

  it("counts an un-migrated owner's legacy shelves against the create cap", async () => {
    await seedUser({ legacyShelves: fullLegacyList() });

    const res = await request("POST", `/api/user/${USER}/public-shelf`, {
      body: JSON.stringify({ title: "第二個書櫃", expiresDays: 30 }),
      token: authToken,
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe("MAX_SHELVES_REACHED");
    // A refused create migrates nothing.
    expect(await pointerRecord()).toBeNull();
  });
});

// ── 5. Un-migrated behaviour is byte-for-byte the old behaviour ─

describe("Books save for an un-migrated owner", () => {
  it.each(BOOKS_SAVES)(
    "$label refreshes the legacy shelves' snapshots and keeps carrying the field",
    async ({ save }) => {
      await seedUser({ legacyShelves: [shelf(SHELF_ID, REVOKED_TOKEN)] });
      await seedSnapshot(shelf(SHELF_ID, REVOKED_TOKEN));
      expect(await publishedBookIds(REVOKED_TOKEN)).toEqual(
        BASELINE_SHARED_IDS,
      );

      const res = await save();
      expect(res.status).toBe(200);

      // Identical to the pre-fix behaviour: the legacy list is still the
      // authority, so its links keep working and its snapshots stay current.
      expect(await publishedBookIds(REVOKED_TOKEN)).toEqual(ROTATED_SHARED_IDS);
      expect((await userRecord())?.publicSharing?.shelves).toEqual([
        shelf(SHELF_ID, REVOKED_TOKEN),
      ]);
      // A books save is still not a migration.
      expect(await pointerRecord()).toBeNull();
    },
  );
});

// ── 6. The third writer of user:{id} publishes nothing ────────

describe("PUT /api/user/:id/family-prefs", () => {
  it("writes no snapshot and reads no shelf list", async () => {
    // The other read-modify-write of `user:{id}`. It may carry the inert legacy
    // field along in its `...existing` spread, which is harmless precisely
    // because it publishes nothing — pinned here so a future snapshot refresh
    // added to this handler would reopen the lost-update hole loudly.
    await seedUser({ legacyShelves: [shelf(SHELF_ID, REVOKED_TOKEN)] });
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
    const ops = watchKvOps(kv);

    const res = await request("PUT", `/api/user/${USER}/family-prefs`, {
      body: JSON.stringify({ hidden: [`${USER}:book1`] }),
      token: authToken,
    });
    expect(res.status).toBe(200);
    // Snapshot the trail before this test's own KV reads join it.
    const readKeys = ops.getKeys();
    const writtenKeys = ops.putKeys();

    expect(writtenKeys).toEqual([kvKeys.user(USER)]);
    expect(await storedSnapshot(REVOKED_TOKEN)).toBeNull();
    expect(await storedSnapshot(LIVE_TOKEN)).toBeNull();
    // No pointer read either (the `token:` read is the auth middleware): a
    // handler that writes no snapshot cannot revive a revoked token, so it
    // deliberately pays nothing for the shelf list.
    expect(readKeys).toEqual([kvKeys.authToken(authToken), kvKeys.user(USER)]);
    expect(await pointerRecord()).toEqual({
      shelves: [shelf(SHELF_ID, LIVE_TOKEN)],
    });
  });
});

// ── 7. Account deletion ───────────────────────────────────────

describe("DELETE /api/user/:id — public-shelf cleanup", () => {
  it("removes the pointer key and every token it listed for a migrated owner", async () => {
    // The legacy field is deliberately stale here: cleanup must follow the
    // RESOLVED list, so it takes the pointer key's token and not this one.
    await seedUser({ legacyShelves: [shelf(SHELF_ID, REVOKED_TOKEN)] });
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));
    await seedSnapshot(shelf(SHELF_ID, REVOKED_TOKEN));

    const res = await request("DELETE", `/api/user/${USER}`, {
      token: authToken,
    });
    expect(res.status).toBe(200);

    expect(await kv.get(kvKeys.publicShelves(USER))).toBeNull();
    expect(await kv.get(kvKeys.user(USER))).toBeNull();
    expect(await storedSnapshot(LIVE_TOKEN)).toBeNull();

    // Documented residual: a snapshot no live shelf list points at is not
    // reclaimed. It is unreadable either way — with both keys gone the liveness
    // guard resolves an empty shelf list.
    expect(await storedSnapshot(REVOKED_TOKEN)).not.toBeNull();
    const orphan = await request("GET", `/api/public/${REVOKED_TOKEN}`);
    await expectAnsweredLikeUnknownToken(orphan);
  });

  it("still cleans up an un-migrated owner's legacy tokens", async () => {
    await seedUser({ legacyShelves: [shelf(SHELF_ID, REVOKED_TOKEN)] });
    await seedSnapshot(shelf(SHELF_ID, REVOKED_TOKEN));

    const res = await request("DELETE", `/api/user/${USER}`, {
      token: authToken,
    });
    expect(res.status).toBe(200);

    expect(await kv.get(kvKeys.user(USER))).toBeNull();
    expect(await storedSnapshot(REVOKED_TOKEN)).toBeNull();
  });
});

// ── 8. Revocation does not depend on the books record ─────────
//
// The account-deletion cleanup above is not atomic: it can fail partway and
// leave the pointer key (and its snapshots) behind with `user:{id}` already
// gone. Revocation reads no `record.books`, so it resolves the shelf list
// pointer-first and must stay possible in that state — otherwise a live public
// link would have no remaining way to be killed.

describe("DELETE /api/user/:id/public-shelf/:shelfId — without a books record", () => {
  function deleteShelf(shelfId: string): Promise<Response> {
    return request("DELETE", `/api/user/${USER}/public-shelf/${shelfId}`, {
      token: authToken,
    });
  }

  it("revokes a shelf whose owner has no user:{id} record at all", async () => {
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));
    expect(await userRecord()).toBeNull();

    const res = await deleteShelf(SHELF_ID);

    expect(res.status).toBe(204);
    expect(await storedSnapshot(LIVE_TOKEN)).toBeNull();
    expect(await pointerRecord()).toEqual({ shelves: [] });

    // Dead for readers, not merely delisted for the owner.
    const publicRead = await request("GET", `/api/public/${LIVE_TOKEN}`);
    await expectAnsweredLikeUnknownToken(publicRead);
  });

  it("still answers 404 for a shelfId the pointer key does not list", async () => {
    // The books record is not what a 404 means here — the resolved shelf list
    // is, exactly as it is for an owner who does have one.
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);

    const res = await deleteShelf(OTHER_SHELF_ID);

    expect(res.status).toBe(404);
    expect(((await res.json()) as Json).error.code).toBe("SHELF_NOT_FOUND");
    expect(await pointerRecord()).toEqual({
      shelves: [shelf(SHELF_ID, LIVE_TOKEN)],
    });
  });

  it.each(SNAPSHOT_REBUILDING_WRITES)(
    "$label still answers 404 on that same state — it cannot rebuild a snapshot without the record",
    async ({ call }) => {
      await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
      await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));

      const res = await call(SHELF_ID);

      expect(res.status).toBe(404);
      expect(((await res.json()) as Json).error.code).toBe("SHELF_NOT_FOUND");
      // A refused write changes nothing: shelf and snapshot both survive.
      expect(await pointerRecord()).toEqual({
        shelves: [shelf(SHELF_ID, LIVE_TOKEN)],
      });
      expect(await storedSnapshot(LIVE_TOKEN)).not.toBeNull();
    },
  );

  it("reads no user:{id} at all for a migrated owner's delete", async () => {
    // Read-cost tripwire, the DELETE counterpart of the public read path's:
    // `user:{id}` IS seeded here and its legacy field would resolve the same
    // shelf, so only the read trail catches a handler that goes back to
    // requiring the books record.
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));
    const ops = watchKvOps(kv);

    const res = await deleteShelf(SHELF_ID);
    expect(res.status).toBe(204);
    // Snapshot the trail before this test's own KV reads join it.
    const readKeys = ops.getKeys();

    // The `token:` read is the auth middleware's; the pointer key is the only
    // read the handler itself pays for.
    expect(readKeys).toEqual([
      kvKeys.authToken(authToken),
      kvKeys.publicShelves(USER),
    ]);
    expect(ops.deleteKeys()).toEqual([kvKeys.publicShelf(LIVE_TOKEN)]);
    expect(ops.putKeys()).toEqual([kvKeys.publicShelves(USER)]);
  });
});

// ── 9. Revocation write ORDER ─────────────────────────────────
//
// With the read-side liveness guard in place, the POINTER write IS the
// revocation and the snapshot delete is merely cleanup — so the pointer write
// has to be the step that lands FIRST. Both partial failures are then
// fail-closed:
//   - pointer write fails  ⇒ nothing happened at all (shelf still listed AND
//     its snapshot still there — consistent; the owner sees a 5xx and retries);
//   - snapshot delete fails ⇒ an orphan the liveness guard already refuses.
// Deleting the snapshot FIRST — the order DELETE used to have — left a third,
// OPEN failure mode: snapshot gone but the shelf STILL listed, so the owner's
// next ordinary books save rebuilt a snapshot under the very token they had
// just revoked and the dead link came back READABLE — indefinitely, for a
// permanent shelf.
//
// Only a cross-op trail can catch a regression here: swap the two writes back
// and `putKeys()` / `deleteKeys()` both stay green, because each list is
// correct on its own. Hence `writeTrail()`.

describe("Public-shelf revocation write order", () => {
  it("writes the pointer key BEFORE deleting the snapshot on DELETE", async () => {
    await seedUser();
    await seedPointer([shelf(SHELF_ID, LIVE_TOKEN)]);
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));
    const ops = watchKvOps(kv);

    const res = await request(
      "DELETE",
      `/api/user/${USER}/public-shelf/${SHELF_ID}`,
      { token: authToken },
    );
    expect(res.status).toBe(204);

    // The handler's COMPLETE mutation sequence, order included. DEV_MODE keeps
    // the pipeline's per-IP counter out of the trail, so these two writes are
    // all of it.
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.publicShelves(USER)}`,
      `delete ${kvKeys.publicShelf(LIVE_TOKEN)}`,
    ]);
  });

  it("deletes the superseded snapshot LAST on reset-token, after publishing the new one", async () => {
    // The rule DELETE was aligned to, pinned so the two cannot drift apart: the
    // NEW token's snapshot goes up first (a reader who already sees the new
    // list never 404s on it), the pointer write then commits the rotation, and
    // the old snapshot — which the guard refuses either way — is cleaned up
    // last.
    await seedUser();
    await seedPointer([shelf(SHELF_ID, REVOKED_TOKEN)]);
    await seedSnapshot(shelf(SHELF_ID, REVOKED_TOKEN));
    const ops = watchKvOps(kv);

    const res = await request(
      "POST",
      `/api/user/${USER}/public-shelf/${SHELF_ID}/reset-token`,
      { token: authToken },
    );
    expect(res.status).toBe(200);
    const newToken = ((await res.json()) as Json).data.shelf.shareToken;
    expect(newToken).not.toBe(REVOKED_TOKEN);

    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.publicShelf(newToken)}`,
      `put ${kvKeys.publicShelves(USER)}`,
      `delete ${kvKeys.publicShelf(REVOKED_TOKEN)}`,
    ]);
  });
});

// ── 10. A corrupted pointer record fails closed ───────────────
//
// Both shelf lists reach the resolver as unvalidated `kv.get(..., "json")`
// casts. A pointer whose `shelves` is not an array still WINS — falling past it
// would resurrect the legacy list, i.e. the revoked token the key exists to
// bury — but degrades to "no shelves" instead of throwing a TypeError, which on
// the PUBLIC path a stranger could otherwise turn into a 500.

describe("A corrupted pointer record", () => {
  /** Write a pointer record whose `shelves` did not survive as an array. */
  function seedCorruptPointer(shelves: unknown): Promise<void> {
    return kv.put(kvKeys.publicShelves(USER), JSON.stringify({ shelves }));
  }

  it("answers the public read like an unknown token rather than 500", async () => {
    // The legacy field is seeded and LIVE, so a 200 here would mean the handler
    // fell past the corrupted pointer — the resurrection this key prevents.
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    await seedCorruptPointer("corrupt");
    await seedSnapshot(shelf(SHELF_ID, LIVE_TOKEN));

    const res = await request("GET", `/api/public/${LIVE_TOKEN}`);

    await expectAnsweredLikeUnknownToken(res);
  });

  it("answers the owner's list with an empty array rather than 500", async () => {
    await seedUser({ legacyShelves: [shelf(SHELF_ID, LIVE_TOKEN)] });
    await seedCorruptPointer(null);

    const res = await request("GET", `/api/user/${USER}/public-shelf`, {
      token: authToken,
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.shelves).toEqual([]);
  });
});
