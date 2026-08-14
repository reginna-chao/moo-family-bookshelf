import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import {
  BoolFlag,
  kvKeys,
  type PublicShelf,
  type UserBooksRecord,
  type PublicShelfSnapshot,
} from "../../src/kv/schema";
import {
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import { PUBLIC_SHELF_WRITE_LIMIT } from "../../src/routes/publicShelf";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = "a".repeat(64);
const OTHER_USER_ID = "b".repeat(64);
const AUTH_TOKEN = "f".repeat(64);
const OTHER_AUTH_TOKEN = "e".repeat(64);

function request(
  method: string,
  path: string,
  opts?: { body?: string; token?: string },
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts?.body) init.body = opts.body;
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

function sampleBooks(): UserBooksRecord["books"] {
  return [
    {
      bookId: "book1",
      title: "Shared Book",
      author: "Author A",
      isbn: "111",
      coverUrl: "https://cdn.readmoo.com/cover1.jpg",
      readmooUrl: "https://readmoo.com/book/book1",
      category: "fiction",
      isShared: BoolFlag.TRUE,
    },
    {
      bookId: "book2",
      title: "Private Book",
      author: "Author B",
      isbn: "222",
      coverUrl: "https://cdn.readmoo.com/cover2.jpg",
      readmooUrl: "https://readmoo.com/book/book2",
      category: "non-fiction",
      isShared: BoolFlag.FALSE,
    },
    {
      bookId: "book3",
      title: "Another Shared",
      author: "Author C",
      isbn: "333",
      coverUrl: "https://cdn.readmoo.com/cover3.jpg",
      readmooUrl: "https://readmoo.com/book/book3",
      category: "fiction",
      isShared: BoolFlag.TRUE,
    },
  ];
}

async function seedUser(userId: string, token: string) {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId,
    displayName: "Test User",
    books: sampleBooks(),
    lastUpdated: new Date().toISOString(),
  };
  await kv.put(kvKeys.user(userId), JSON.stringify(record));
  await seedAuthToken(kv, userId, { token });
}

/**
 * Seed `user:{userId}` listing exactly `shelves`, with no auth token — for the
 * suites that only exercise the public read path.
 *
 * Omit `shelves` entirely to seed a record with NO `publicSharing` block (the
 * shape every account carries before it ever creates a public shelf); pass `[]`
 * for a record whose shelves were all removed.
 *
 * Needed because a PERMANENT snapshot (`expiresAt: null`) is served only while
 * this record still lists its shelf under the SAME share token — see the
 * liveness suite below. A hand-seeded snapshot with no matching record here is
 * an orphan and answers 404.
 */
async function seedUserWithShelves(userId: string, shelves?: PublicShelf[]) {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId,
    displayName: "Test User",
    books: sampleBooks(),
    lastUpdated: new Date().toISOString(),
    publicSharing: shelves ? { shelves } : undefined,
  };
  await kv.put(kvKeys.user(userId), JSON.stringify(record));
}

async function seedMember(userId: string, familyId: string) {
  await kv.put(kvKeys.member(userId), familyId);
}

async function createShelf(
  userId: string,
  token: string,
  opts?: { title?: string; expiresDays?: number | null },
): Promise<Json> {
  const body = {
    title: opts?.title ?? "我的公開書櫃",
    expiresDays: opts?.expiresDays !== undefined ? opts.expiresDays : 30,
  };
  const res = await request("POST", `/api/user/${userId}/public-shelf`, {
    body: JSON.stringify(body),
    token,
  });
  return { res, json: (await res.json()) as Json };
}

beforeEach(() => {
  kv = createMockKV();
});

// ── POST /api/user/:id/public-shelf ───────────────────────────

describe("POST /api/user/:id/public-shelf", () => {
  it("creates a shelf and returns 201 with correct fields", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const { res, json } = await createShelf(USER_ID, AUTH_TOKEN);

    expect(res.status).toBe(201);
    expect(json.data.shelf.shelfId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(json.data.shelf.shareToken).toMatch(/^[a-f0-9]{32}$/);
    expect(json.data.shelf.title).toBe("我的公開書櫃");
    expect(json.data.shelf.expiresDays).toBe(30);
    expect(json.data.shelf.selectionMode).toBe("all-shared");
    expect(json.data.shelf.createdAt).toBeTypeOf("number");
    expect(json.data.shelf.expiresAt).toBeTypeOf("number");
  });

  it("writes a public snapshot with only shared books", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const { json } = await createShelf(USER_ID, AUTH_TOKEN);
    const token = json.data.shelf.shareToken;

    const snapshot = (await kv.get(
      kvKeys.publicShelf(token),
      "json",
    )) as PublicShelfSnapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot.books).toHaveLength(2);
    expect(
      snapshot.books.every((b: Json) => b.isShared === BoolFlag.TRUE),
    ).toBe(true);
    expect(snapshot.title).toBe("我的公開書櫃");
  });

  it("creates a permanent shelf (expiresDays=null)", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const { res, json } = await createShelf(USER_ID, AUTH_TOKEN, {
      expiresDays: null,
    });

    expect(res.status).toBe(201);
    expect(json.data.shelf.expiresDays).toBeNull();
    expect(json.data.shelf.expiresAt).toBeNull();

    const snapshot = (await kv.get(
      kvKeys.publicShelf(json.data.shelf.shareToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(snapshot.expiresAt).toBeNull();
  });

  it("returns 400 for empty title", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await request("POST", `/api/user/${USER_ID}/public-shelf`, {
      body: JSON.stringify({ title: "", expiresDays: 30 }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_TITLE");
  });

  it("returns 400 for invalid expiresDays", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await request("POST", `/api/user/${USER_ID}/public-shelf`, {
      body: JSON.stringify({ title: "Test", expiresDays: 15 }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_EXPIRES_DAYS");
  });

  it("returns 401 without auth token", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await request("POST", `/api/user/${USER_ID}/public-shelf`, {
      body: JSON.stringify({ title: "Test", expiresDays: 30 }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 403 when token belongs to different user", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await seedUser(OTHER_USER_ID, OTHER_AUTH_TOKEN);

    const res = await request("POST", `/api/user/${USER_ID}/public-shelf`, {
      body: JSON.stringify({ title: "Test", expiresDays: 30 }),
      token: OTHER_AUTH_TOKEN,
    });

    expect(res.status).toBe(403);
  });

  it("returns 409 when shelf limit reached", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await createShelf(USER_ID, AUTH_TOKEN);

    const { res, json } = await createShelf(USER_ID, AUTH_TOKEN, {
      title: "Second",
    });

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("MAX_SHELVES_REACHED");
  });

  it("returns 400 when user has no books record", async () => {
    await seedAuthToken(kv, USER_ID, { token: AUTH_TOKEN });

    const { res, json } = await createShelf(USER_ID, AUTH_TOKEN);

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("USER_NOT_FOUND");
  });
});

// ── GET /api/user/:id/public-shelf ────────────────────────────

describe("GET /api/user/:id/public-shelf", () => {
  it("returns empty shelves when none exist", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await request("GET", `/api/user/${USER_ID}/public-shelf`, {
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.shelves).toEqual([]);
  });

  it("returns existing shelf", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await createShelf(USER_ID, AUTH_TOKEN);

    const res = await request("GET", `/api/user/${USER_ID}/public-shelf`, {
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.shelves).toHaveLength(1);
    expect(json.data.shelves[0].title).toBe("我的公開書櫃");
  });

  it("returns 401 without auth", async () => {
    const res = await request("GET", `/api/user/${USER_ID}/public-shelf`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for other user", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await seedUser(OTHER_USER_ID, OTHER_AUTH_TOKEN);

    const res = await request("GET", `/api/user/${USER_ID}/public-shelf`, {
      token: OTHER_AUTH_TOKEN,
    });
    expect(res.status).toBe(403);
  });
});

// ── PUT /api/user/:id/public-shelf/:shelfId ───────────────────

describe("PUT /api/user/:id/public-shelf/:shelfId", () => {
  it("updates title and reflects in snapshot", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shelfId = created.data.shelf.shelfId;
    const shareToken = created.data.shelf.shareToken;

    const res = await request(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${shelfId}`,
      {
        body: JSON.stringify({ title: "新標題" }),
        token: AUTH_TOKEN,
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.shelf.title).toBe("新標題");

    const snapshot = (await kv.get(
      kvKeys.publicShelf(shareToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(snapshot.title).toBe("新標題");
  });

  it("updates expiresDays and recalculates expiresAt from now", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN, {
      expiresDays: 30,
    });
    const shelfId = created.data.shelf.shelfId;

    const before = Date.now();
    const res = await request(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${shelfId}`,
      {
        body: JSON.stringify({ expiresDays: 90 }),
        token: AUTH_TOKEN,
      },
    );
    const after = Date.now();

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.shelf.expiresDays).toBe(90);
    const expectedMin = before + 90 * 86_400_000;
    const expectedMax = after + 90 * 86_400_000;
    expect(json.data.shelf.expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(json.data.shelf.expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  it("returns 400 when neither title nor expiresDays provided", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);

    const res = await request(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${created.data.shelf.shelfId}`,
      {
        body: JSON.stringify({}),
        token: AUTH_TOKEN,
      },
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 404 for non-existent shelfId", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const fakeShelfId = "12345678-1234-4123-8123-123456789abc";
    const res = await request(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${fakeShelfId}`,
      {
        body: JSON.stringify({ title: "Test" }),
        token: AUTH_TOKEN,
      },
    );

    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("SHELF_NOT_FOUND");
  });
});

// ── POST /api/user/:id/public-shelf/:shelfId/reset-token ──────

describe("POST reset-token", () => {
  it("generates a new token different from old one", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shelfId = created.data.shelf.shelfId;
    const oldToken = created.data.shelf.shareToken;

    const res = await request(
      "POST",
      `/api/user/${USER_ID}/public-shelf/${shelfId}/reset-token`,
      {
        token: AUTH_TOKEN,
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.shelf.shareToken).not.toBe(oldToken);
    expect(json.data.shelf.shareToken).toMatch(/^[a-f0-9]{32}$/);
    expect(json.data.shelf.shelfId).toBe(shelfId);
  });

  it("deletes old token KV and creates new one", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shelfId = created.data.shelf.shelfId;
    const oldToken = created.data.shelf.shareToken;

    const res = await request(
      "POST",
      `/api/user/${USER_ID}/public-shelf/${shelfId}/reset-token`,
      {
        token: AUTH_TOKEN,
      },
    );
    const json = (await res.json()) as Json;
    const newToken = json.data.shelf.shareToken;

    const oldSnapshot = await kv.get(kvKeys.publicShelf(oldToken));
    expect(oldSnapshot).toBeNull();

    const newSnapshot = (await kv.get(
      kvKeys.publicShelf(newToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(newSnapshot).not.toBeNull();
    expect(newSnapshot.books).toHaveLength(2);
  });

  it("returns 404 for non-existent shelfId", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const fakeShelfId = "12345678-1234-4123-8123-123456789abc";
    const res = await request(
      "POST",
      `/api/user/${USER_ID}/public-shelf/${fakeShelfId}/reset-token`,
      {
        token: AUTH_TOKEN,
      },
    );

    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/user/:id/public-shelf/:shelfId ────────────────

describe("DELETE /api/user/:id/public-shelf/:shelfId", () => {
  it("removes shelf from user record and deletes snapshot", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shelfId = created.data.shelf.shelfId;
    const shareToken = created.data.shelf.shareToken;

    const res = await request(
      "DELETE",
      `/api/user/${USER_ID}/public-shelf/${shelfId}`,
      {
        token: AUTH_TOKEN,
      },
    );

    expect(res.status).toBe(204);

    const record = (await kv.get(
      kvKeys.user(USER_ID),
      "json",
    )) as UserBooksRecord;
    expect(record.publicSharing?.shelves).toHaveLength(0);

    const snapshot = await kv.get(kvKeys.publicShelf(shareToken));
    expect(snapshot).toBeNull();
  });

  it("returns 404 for non-existent shelfId", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const fakeShelfId = "12345678-1234-4123-8123-123456789abc";
    const res = await request(
      "DELETE",
      `/api/user/${USER_ID}/public-shelf/${fakeShelfId}`,
      {
        token: AUTH_TOKEN,
      },
    );

    expect(res.status).toBe(404);
  });
});

// ── Per-userId public-shelf write ceiling ─────────────────────
//
// The four authenticated write handlers (create / update / reset-token /
// delete) share ONE per-userId counter, so a single account cannot drain the
// Worker's daily KV write quota by rotating source addresses — reset-token
// alone costs 4 KV operations per call.
//
// These cases run WITHOUT DEV_MODE, which every other case in this file sets:
// DEV_MODE short-circuits `enforcePerUserRateLimit`, so the ceiling would never
// fire. Setup that must not spend the budget still goes through the DEV_MODE
// helpers on purpose.

/**
 * The very options object the four `enforcePerUserRateLimit` call sites in
 * `src/routes/publicShelf.ts` spread, imported rather than copied — so the
 * boundary cases below (last write admitted, next one refused) track any change
 * to the ceiling instead of silently drifting from it. The counter KEY is
 * likewise always derived through the production key builder
 * (`peekPerUserRateLimit`).
 */
const {
  scope: WRITE_SCOPE,
  max: WRITE_MAX,
  windowSec: WRITE_WINDOW_SECONDS,
} = PUBLIC_SHELF_WRITE_LIMIT;

/** Exactly mid-window, so the counter cannot roll over mid-test. */
const PINNED_WRITE_NOW = Date.parse("2026-01-01T00:30:00.000Z");

describe("Public shelf per-userId write ceiling", () => {
  /**
   * Same as {@link request} but WITHOUT `DEV_MODE`, so the live limiters run.
   */
  async function prodRequest(
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
    return app.request(path, init, { KV: kv });
  }

  const createBody = (title = "共用額度") =>
    JSON.stringify({ title, expiresDays: 30 });

  /** `token` is always explicit — an omitted one means "send no credentials". */
  function createWrite(token: string | undefined, title?: string) {
    return prodRequest("POST", `/api/user/${USER_ID}/public-shelf`, {
      body: createBody(title),
      token,
    });
  }

  /** Counter key of the user's CURRENT window, via the production builder. */
  async function writeCounterKey(userId: string): Promise<string> {
    const reading = await peekPerUserRateLimit(kv, {
      userId,
      scope: WRITE_SCOPE,
      max: WRITE_MAX,
      windowSec: WRITE_WINDOW_SECONDS,
    });
    return reading.key;
  }

  /** Writes charged to the account so far, or null if never charged. */
  async function writesCharged(userId: string): Promise<number | null> {
    const raw = await kv.get(await writeCounterKey(userId));
    return raw === null ? null : parseInt(raw, 10);
  }

  /** Every public-shelf counter key currently in KV, whatever the userId. */
  async function counterKeys(): Promise<string[]> {
    const listed = await kv.list();
    return listed.keys
      .map((k: { name: string }) => k.name)
      .filter((name: string) =>
        name.startsWith(`ratelimit:user:${WRITE_SCOPE}:`),
      );
  }

  /** Pre-spend `used` slots — far cheaper than 30 real writes. */
  async function spendWriteBudget(userId: string, used: number): Promise<void> {
    await kv.put(await writeCounterKey(userId), String(used), {
      expirationTtl: WRITE_WINDOW_SECONDS * 2,
    });
  }

  /**
   * The four write endpoints of USER_ID, each acting on an existing shelf.
   * `token` is a parameter so the same table can drive the ceiling cases and
   * the auth-ordering cases (no token → 401, someone else's token → 403).
   */
  const WRITE_ENDPOINTS: {
    label: string;
    call: (shelfId: string, token?: string) => Promise<Response>;
  }[] = [
    {
      label: "POST create",
      call: (_shelfId, token) => createWrite(token, "另一個書櫃"),
    },
    {
      label: "PUT update",
      call: (shelfId, token) =>
        prodRequest("PUT", `/api/user/${USER_ID}/public-shelf/${shelfId}`, {
          body: JSON.stringify({ title: "新標題" }),
          token,
        }),
    },
    {
      label: "POST reset-token",
      call: (shelfId, token) =>
        prodRequest(
          "POST",
          `/api/user/${USER_ID}/public-shelf/${shelfId}/reset-token`,
          { token },
        ),
    },
    {
      label: "DELETE",
      call: (shelfId, token) =>
        prodRequest("DELETE", `/api/user/${USER_ID}/public-shelf/${shelfId}`, {
          token,
        }),
    },
  ];

  /** Seed a user plus one shelf without spending any of the live budget. */
  async function seedUserWithShelf(): Promise<Json> {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json } = await createShelf(USER_ID, AUTH_TOKEN);
    return json.data.shelf;
  }

  beforeEach(() => {
    // Pin Date (timers stay real) so the 1-hour window cannot roll over between
    // seeding the counter and the request under test.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_WRITE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges one slot per write and keeps the counter self-expiring", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await createWrite(AUTH_TOKEN);

    expect(res.status).toBe(201);
    expect(await writesCharged(USER_ID)).toBe(1);
    // Without a TTL the counter would live in KV forever.
    expect(getPutTtl(kv, await writeCounterKey(USER_ID))).toBe(
      WRITE_WINDOW_SECONDS * 2,
    );
  });

  it.each(WRITE_ENDPOINTS)(
    "refuses $label with 429 once the shared window is spent",
    async ({ call }) => {
      const shelf = await seedUserWithShelf();
      await spendWriteBudget(USER_ID, WRITE_MAX);

      const res = await call(shelf.shelfId, AUTH_TOKEN);

      expect(res.status).toBe(429);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("RATE_LIMITED");
      expect(json.error.message).toBe(RATE_LIMITED_MESSAGE);
      // The pinned clock sits exactly mid-window, so the back-off hint is half
      // the window — which also pins the window length end to end.
      expect(json.error.retryAfter).toBe(WRITE_WINDOW_SECONDS / 2);
      expect(res.headers.get("Retry-After")).toBe(
        String(json.error.retryAfter),
      );
      // A refused write must not extend the window.
      expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
    },
  );

  it("admits the last write the window has room for and refuses the next", async () => {
    const shelf = await seedUserWithShelf();
    await spendWriteBudget(USER_ID, WRITE_MAX - 1);

    const lastAllowed = await prodRequest(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${shelf.shelfId}`,
      { body: JSON.stringify({ title: "剛好用完" }), token: AUTH_TOKEN },
    );
    expect(lastAllowed.status).toBe(200);
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);

    const overCeiling = await prodRequest(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${shelf.shelfId}`,
      { body: JSON.stringify({ title: "超過額度" }), token: AUTH_TOKEN },
    );
    expect(overCeiling.status).toBe(429);
  });

  it("counts create, update, reset-token and delete against ONE shared window", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await spendWriteBudget(USER_ID, WRITE_MAX - 4);

    const created = await createWrite(AUTH_TOKEN);
    expect(created.status).toBe(201);
    const shelfId = ((await created.json()) as Json).data.shelf.shelfId;

    const updated = await prodRequest(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${shelfId}`,
      { body: JSON.stringify({ title: "改名" }), token: AUTH_TOKEN },
    );
    expect(updated.status).toBe(200);

    const reset = await prodRequest(
      "POST",
      `/api/user/${USER_ID}/public-shelf/${shelfId}/reset-token`,
      { token: AUTH_TOKEN },
    );
    expect(reset.status).toBe(200);

    const removed = await prodRequest(
      "DELETE",
      `/api/user/${USER_ID}/public-shelf/${shelfId}`,
      { token: AUTH_TOKEN },
    );
    expect(removed.status).toBe(204);

    // Four different handlers, one counter.
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);

    // The user now holds zero shelves, so this create is legal on every count
    // except the shared window — which is exactly what the scope enforces.
    const refused = await createWrite(AUTH_TOKEN, "超額的新書櫃");
    expect(refused.status).toBe(429);

    const record = (await kv.get(
      kvKeys.user(USER_ID),
      "json",
    )) as UserBooksRecord;
    expect(record.publicSharing?.shelves).toHaveLength(0);
  });

  it("leaves the share token and its snapshot untouched when reset-token is refused", async () => {
    const shelf = await seedUserWithShelf();
    const snapshotBefore = await kv.get(kvKeys.publicShelf(shelf.shareToken));
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const res = await prodRequest(
      "POST",
      `/api/user/${USER_ID}/public-shelf/${shelf.shelfId}/reset-token`,
      { token: AUTH_TOKEN },
    );
    expect(res.status).toBe(429);

    const record = (await kv.get(
      kvKeys.user(USER_ID),
      "json",
    )) as UserBooksRecord;
    expect(record.publicSharing?.shelves[0].shareToken).toBe(shelf.shareToken);
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).toBe(
      snapshotBefore,
    );

    // ...and no snapshot was minted under a fresh token either.
    const listed = await kv.list();
    const snapshots = listed.keys.filter((k: { name: string }) =>
      k.name.startsWith("public:"),
    );
    expect(snapshots).toHaveLength(1);
  });

  it("keeps the shelf when a delete is refused", async () => {
    const shelf = await seedUserWithShelf();
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const res = await prodRequest(
      "DELETE",
      `/api/user/${USER_ID}/public-shelf/${shelf.shelfId}`,
      { token: AUTH_TOKEN },
    );
    expect(res.status).toBe(429);

    const record = (await kv.get(
      kvKeys.user(USER_ID),
      "json",
    )) as UserBooksRecord;
    expect(record.publicSharing?.shelves).toHaveLength(1);
    expect(await kv.get(kvKeys.publicShelf(shelf.shareToken))).not.toBeNull();
  });

  it("charges a write that is rejected later by validation", async () => {
    // The ceiling runs before body parsing, so a malformed-body flood costs the
    // attacker budget just like a valid one.
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await prodRequest("POST", `/api/user/${USER_ID}/public-shelf`, {
      body: JSON.stringify({ title: "", expiresDays: 30 }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_TITLE");
    expect(await writesCharged(USER_ID)).toBe(1);
  });

  it("answers 429 rather than 400 for a malformed body once the window is spent", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const res = await prodRequest("POST", `/api/user/${USER_ID}/public-shelf`, {
      body: "{not json}",
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(429);
  });

  // The ceiling runs AFTER the auth check on purpose: a stranger must not be
  // able to spend the account owner's write budget.

  it.each(WRITE_ENDPOINTS)(
    "answers $label with 401 without charging the account",
    async ({ call }) => {
      const shelf = await seedUserWithShelf();

      const res = await call(shelf.shelfId);

      expect(res.status).toBe(401);
      expect(await writesCharged(USER_ID)).toBeNull();
      expect(await counterKeys()).toHaveLength(0);
    },
  );

  it.each(WRITE_ENDPOINTS)(
    "answers $label with 403 for another user's token without charging the victim",
    async ({ call }) => {
      const shelf = await seedUserWithShelf();
      await seedUser(OTHER_USER_ID, OTHER_AUTH_TOKEN);

      const res = await call(shelf.shelfId, OTHER_AUTH_TOKEN);

      expect(res.status).toBe(403);
      expect(await writesCharged(USER_ID)).toBeNull();
      expect(await writesCharged(OTHER_USER_ID)).toBeNull();
      expect(await counterKeys()).toHaveLength(0);
    },
  );

  it("counts each userId independently", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await seedUser(OTHER_USER_ID, OTHER_AUTH_TOKEN);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const blocked = await createWrite(AUTH_TOKEN);
    expect(blocked.status).toBe(429);

    const allowed = await prodRequest(
      "POST",
      `/api/user/${OTHER_USER_ID}/public-shelf`,
      { body: createBody(), token: OTHER_AUTH_TOKEN },
    );
    expect(allowed.status).toBe(201);
    expect(await writesCharged(OTHER_USER_ID)).toBe(1);
  });

  it("still serves the read paths when the write window is spent", async () => {
    const shelf = await seedUserWithShelf();
    await spendWriteBudget(USER_ID, WRITE_MAX);

    const list = await prodRequest("GET", `/api/user/${USER_ID}/public-shelf`, {
      token: AUTH_TOKEN,
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as Json).data.shelves).toHaveLength(1);

    const snapshot = await prodRequest(
      "GET",
      `/api/public/${shelf.shareToken}`,
    );
    expect(snapshot.status).toBe(200);
  });

  it("does not apply the write ceiling in dev mode", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await spendWriteBudget(USER_ID, WRITE_MAX);

    // Same request through the DEV_MODE helper — local wrangler dev and E2E
    // runs must not be throttled.
    const { res } = await createShelf(USER_ID, AUTH_TOKEN);

    expect(res.status).toBe(201);
    // Dev mode neither reads nor charges the counter.
    expect(await writesCharged(USER_ID)).toBe(WRITE_MAX);
  });
});

// ── GET /api/public/:shareToken ───────────────────────────────

describe("GET /api/public/:shareToken", () => {
  it("returns public shelf data without userId or shelfId", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shareToken = created.data.shelf.shareToken;

    const res = await request("GET", `/api/public/${shareToken}`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.title).toBe("我的公開書櫃");
    expect(json.data.books).toHaveLength(2);
    expect(json.data.createdAt).toBeTypeOf("number");
    expect(json.data).not.toHaveProperty("userId");
    expect(json.data).not.toHaveProperty("shelfId");
  });

  it("does not require authentication", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);

    const res = await request(
      "GET",
      `/api/public/${created.data.shelf.shareToken}`,
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 for non-existent token", async () => {
    const fakeToken = "a".repeat(32);
    const res = await request("GET", `/api/public/${fakeToken}`);

    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("PUBLIC_SHELF_NOT_FOUND");
  });

  it("returns 400 for invalid token format", async () => {
    const res = await request("GET", "/api/public/not-a-valid-token");

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_TOKEN");
  });
});

// ── GET /api/public/:shareToken — expiry backstop ─────────────
//
// KV TTL is the primary expiry mechanism, but a snapshot can outlive its shelf
// (e.g. reset-token's final delete failed) — and this mock KV never expires a
// key at all, which is exactly the orphan situation the handler's own
// `expiresAt` check has to answer for.

describe("GET /api/public/:shareToken — expiry backstop", () => {
  const SHARE_TOKEN = "abcdef0123456789abcdef0123456789";
  const UNKNOWN_TOKEN = "0".repeat(32);
  const SHELF_ID = "12345678-1234-4123-8123-123456789abc";
  const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");
  const SNAPSHOT_TITLE = "快過期的書櫃";

  beforeEach(() => {
    // Pin Date (timers stay real) so "exactly now" is an exact boundary.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Seed a snapshot AND the live shelf backing it, so every row below isolates
   * the `expiresAt` boundary: with a live shelf, a 404 can only come from the
   * deadline, never from the permanent-shelf liveness guard (which would 404 a
   * permanent snapshot whose shelf is gone — see the suite after this one).
   */
  async function seedSnapshot(expiresAt: number | null): Promise<void> {
    const snapshot: PublicShelfSnapshot = {
      userId: USER_ID,
      shelfId: SHELF_ID,
      title: SNAPSHOT_TITLE,
      books: sampleBooks().filter((b) => b.isShared === BoolFlag.TRUE),
      createdAt: PINNED_NOW - 86_400_000,
      expiresAt,
    };
    await kv.put(kvKeys.publicShelf(SHARE_TOKEN), JSON.stringify(snapshot));
    await seedUserWithShelves(USER_ID, [
      {
        shelfId: SHELF_ID,
        shareToken: SHARE_TOKEN,
        title: SNAPSHOT_TITLE,
        expiresDays: expiresAt === null ? null : 7,
        createdAt: PINNED_NOW - 86_400_000,
        expiresAt,
        selectionMode: "all-shared",
      },
    ]);
  }

  it.each([
    {
      label: "expired an hour ago",
      expiresAt: PINNED_NOW - 3_600_000,
      status: 404,
    },
    { label: "expiring exactly now", expiresAt: PINNED_NOW, status: 404 },
    {
      label: "expiring in one millisecond",
      expiresAt: PINNED_NOW + 1,
      status: 200,
    },
    { label: "permanent (expiresAt null)", expiresAt: null, status: 200 },
  ])("answers $status for a snapshot $label", async ({ expiresAt, status }) => {
    await seedSnapshot(expiresAt);

    const res = await request("GET", `/api/public/${SHARE_TOKEN}`);

    expect(res.status).toBe(status);
  });

  it("answers an expired snapshot exactly like an unknown token", async () => {
    await seedSnapshot(PINNED_NOW - 1);

    const expired = await request("GET", `/api/public/${SHARE_TOKEN}`);
    const unknown = await request("GET", `/api/public/${UNKNOWN_TOKEN}`);

    // Indistinguishable: an expired token must not confirm it ever existed.
    expect(expired.status).toBe(unknown.status);
    expect(await expired.json()).toEqual(await unknown.json());
  });

  it("discloses neither title nor books once the snapshot has expired", async () => {
    await seedSnapshot(PINNED_NOW - 1);

    const res = await request("GET", `/api/public/${SHARE_TOKEN}`);

    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("PUBLIC_SHELF_NOT_FOUND");
    expect(json.data).toBeUndefined();
    const body = JSON.stringify(json);
    expect(body).not.toContain(SNAPSHOT_TITLE);
    expect(body).not.toContain("Shared Book");
  });

  it("refuses the expired snapshot without deleting it (read path stays side-effect free)", async () => {
    await seedSnapshot(PINNED_NOW - 1);

    const res = await request("GET", `/api/public/${SHARE_TOKEN}`);
    expect(res.status).toBe(404);

    expect(await kv.get(kvKeys.publicShelf(SHARE_TOKEN))).not.toBeNull();
  });

  it("stops serving a real shelf once its expiry passes", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN, {
      expiresDays: 7,
    });
    const shareToken = created.data.shelf.shareToken;

    const fresh = await request("GET", `/api/public/${shareToken}`);
    expect(fresh.status).toBe(200);

    // The mock never expires keys, so the snapshot survives its KV TTL — the
    // orphan case this backstop exists for.
    vi.setSystemTime(PINNED_NOW + 8 * 86_400_000);

    const stale = await request("GET", `/api/public/${shareToken}`);
    expect(stale.status).toBe(404);
    expect(((await stale.json()) as Json).error.code).toBe(
      "PUBLIC_SHELF_NOT_FOUND",
    );
  });
});

// ── GET /api/public/:shareToken — permanent shelf liveness ────
//
// A PERMANENT snapshot (`expiresAt: null`) carries neither a KV TTL nor a
// deadline, so nothing else can ever retire it: if its share token is rotated,
// its shelf deleted, or the whole account removed while the `public:` key
// survives (a failed cleanup write), the snapshot would stay publicly readable
// forever. The handler therefore validates such a snapshot against the owner's
// record on read, and answers exactly like a token that never existed.

describe("GET /api/public/:shareToken — permanent shelf liveness", () => {
  const PERM_TOKEN = "1a2b3c4d5e6f70819a2b3c4d5e6f7081";
  const ROTATED_TOKEN = "99887766554433221100ffeeddccbbaa";
  const TIMED_TOKEN = "0f1e2d3c4b5a69780f1e2d3c4b5a6978";
  const UNKNOWN_TOKEN = "0".repeat(32);
  const SHELF_ID = "12345678-1234-4123-8123-123456789abc";
  const OTHER_SHELF_ID = "abcdef01-2345-4678-89ab-cdef01234567";
  const SNAPSHOT_TITLE = "永久公開書櫃";
  const CREATED_AT = Date.parse("2026-02-01T00:00:00.000Z");
  const DAY_MS = 86_400_000;

  /** Keys touched by KV, recorded per operation. */
  interface KvOpLog {
    getKeys: () => string[];
    putKeys: () => string[];
    deleteKeys: () => string[];
  }

  /**
   * Start recording KV operations WITHOUT changing behaviour — the spies call
   * straight through to `createMockKV()`, so production writes still meet its
   * TTL floor. Call it AFTER seeding so only the request under test is counted.
   *
   * Scope of the `putKeys()` / `deleteKeys()` assertions below: they pin the
   * HANDLER only. Every request here goes through {@link request}, which sends
   * `DEV_MODE`, and the per-IP `rateLimit` middleware short-circuits in dev mode
   * — so its one counter `put` per request (the pipeline's only fixed write) is
   * absent by construction and is NOT what these assertions prove.
   */
  function watchKvOps(): KvOpLog {
    const gets = vi.spyOn(kv, "get");
    const puts = vi.spyOn(kv, "put");
    const deletes = vi.spyOn(kv, "delete");
    const keysOf = (spy: { mock: { calls: unknown[][] } }): string[] =>
      spy.mock.calls.map((call) => String(call[0]));
    return {
      getKeys: () => keysOf(gets),
      putKeys: () => keysOf(puts),
      deleteKeys: () => keysOf(deletes),
    };
  }

  async function seedSnapshot(
    shareToken: string,
    expiresAt: number | null,
  ): Promise<void> {
    const snapshot: PublicShelfSnapshot = {
      userId: USER_ID,
      shelfId: SHELF_ID,
      title: SNAPSHOT_TITLE,
      books: sampleBooks().filter((b) => b.isShared === BoolFlag.TRUE),
      createdAt: CREATED_AT,
      expiresAt,
    };
    await kv.put(kvKeys.publicShelf(shareToken), JSON.stringify(snapshot));
  }

  /** A permanent shelf entry as the owner's record would list it. */
  function shelfEntry(shelfId: string, shareToken: string): PublicShelf {
    return {
      shelfId,
      shareToken,
      title: SNAPSHOT_TITLE,
      expiresDays: null,
      createdAt: CREATED_AT,
      expiresAt: null,
      selectionMode: "all-shared",
    };
  }

  /**
   * The SAME shelf after the owner converted it to time-limited: identical
   * shelfId and share token, only a deadline added. The deadline is in the
   * FUTURE on purpose — this shelf is perfectly alive, so a 404 can only come
   * from the permanent snapshot contradicting the record, never from expiry.
   */
  function convertedShelfEntry(
    shelfId: string,
    shareToken: string,
  ): PublicShelf {
    return {
      ...shelfEntry(shelfId, shareToken),
      expiresDays: 7,
      expiresAt: Date.now() + 7 * DAY_MS,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Every way a permanent snapshot can outlive the shelf it belongs to. The
   * snapshot itself is identical in all of them — only the owner's record
   * differs, which is exactly what the guard reads.
   */
  const ORPHAN_CASES: { label: string; seedRecord: () => Promise<void> }[] = [
    {
      label: "the owner's account was deleted",
      seedRecord: () => Promise.resolve(),
    },
    {
      label: "the record no longer lists any shelf",
      seedRecord: () => seedUserWithShelves(USER_ID, []),
    },
    {
      label: "the record has no publicSharing block at all",
      seedRecord: () => seedUserWithShelves(USER_ID),
    },
    {
      label: "the shelf now points at a rotated token",
      seedRecord: () =>
        seedUserWithShelves(USER_ID, [shelfEntry(SHELF_ID, ROTATED_TOKEN)]),
    },
    {
      label: "only a different shelf carries the token",
      seedRecord: () =>
        seedUserWithShelves(USER_ID, [shelfEntry(OTHER_SHELF_ID, PERM_TOKEN)]),
    },
    {
      // The one orphan the record still points straight at: same shelfId, same
      // token, but the shelf is no longer permanent. Reached when the update
      // handler rewrote the record to time-limited and its snapshot rewrite
      // failed, leaving a TTL-less permanent snapshot under the live token —
      // which would otherwise outlive, and contradict, the owner's own setting.
      label: "the shelf was converted to time-limited",
      seedRecord: () =>
        seedUserWithShelves(USER_ID, [
          convertedShelfEntry(SHELF_ID, PERM_TOKEN),
        ]),
    },
  ];

  it.each(ORPHAN_CASES)(
    "answers a permanent orphan exactly like an unknown token when $label",
    async ({ seedRecord }) => {
      await seedSnapshot(PERM_TOKEN, null);
      await seedRecord();
      const ops = watchKvOps();

      const orphan = await request("GET", `/api/public/${PERM_TOKEN}`);
      const unknown = await request("GET", `/api/public/${UNKNOWN_TOKEN}`);

      // Byte-identical, not merely "both 404": an orphan must not confirm that
      // the token ever existed.
      expect(orphan.status).toBe(404);
      expect(orphan.status).toBe(unknown.status);
      expect(orphan.headers.get("content-type")).toBe(
        unknown.headers.get("content-type"),
      );
      const body = await orphan.text();
      expect(body).toBe(await unknown.text());
      expect(JSON.parse(body).error.code).toBe("PUBLIC_SHELF_NOT_FOUND");
      expect(body).not.toContain(SNAPSHOT_TITLE);
      expect(body).not.toContain("Shared Book");

      // Read path stays side-effect free: a stranger must never be able to
      // drive a KV write, so the dead snapshot is refused, not cleaned up.
      // (Handler scope only — see `watchKvOps`.)
      expect(ops.putKeys()).toEqual([]);
      expect(ops.deleteKeys()).toEqual([]);
      expect(await kv.get(kvKeys.publicShelf(PERM_TOKEN))).not.toBeNull();
    },
  );

  it("serves a permanent shelf its owner's record still lists", async () => {
    await seedSnapshot(PERM_TOKEN, null);
    await seedUserWithShelves(USER_ID, [shelfEntry(SHELF_ID, PERM_TOKEN)]);

    const res = await request("GET", `/api/public/${PERM_TOKEN}`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.title).toBe(SNAPSHOT_TITLE);
    expect(json.data.books.map((b: Json) => b.bookId)).toEqual([
      "book1",
      "book3",
    ]);
    expect(json.data.createdAt).toBe(CREATED_AT);
    expect(json.data.expiresAt).toBeNull();
  });

  it("keeps serving a permanent shelf created through the API", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN, {
      expiresDays: null,
    });

    const res = await request(
      "GET",
      `/api/public/${created.data.shelf.shareToken}`,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.expiresAt).toBeNull();
  });

  it("refuses a permanent snapshot that reset-token failed to delete", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN, {
      expiresDays: null,
    });
    const { shelfId, shareToken: oldToken } = created.data.shelf;
    const orphanedSnapshot = (await kv.get(
      kvKeys.publicShelf(oldToken),
    )) as string;

    const reset = await request(
      "POST",
      `/api/user/${USER_ID}/public-shelf/${shelfId}/reset-token`,
      { token: AUTH_TOKEN },
    );
    const newToken = ((await reset.json()) as Json).data.shelf.shareToken;

    // The rotation's final `delete` is the last of four KV ops and can fail:
    // put the old snapshot back to stand in for that partial cleanup.
    await kv.put(kvKeys.publicShelf(oldToken), orphanedSnapshot);

    const rotated = await request("GET", `/api/public/${newToken}`);
    expect(rotated.status).toBe(200);

    const revoked = await request("GET", `/api/public/${oldToken}`);
    expect(revoked.status).toBe(404);
    expect(((await revoked.json()) as Json).error.code).toBe(
      "PUBLIC_SHELF_NOT_FOUND",
    );
  });

  it("keeps serving a permanent shelf successfully converted to time-limited", async () => {
    // The counterpart of the drift row above: when the update handler's
    // snapshot rewrite SUCCEEDS, the stored snapshot carries the new deadline,
    // so the liveness guard is out of the picture and the conversion is
    // invisible to readers. Driven through the API, not hand-seeded, so a
    // handler that stopped rewriting the snapshot fails here.
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN, {
      expiresDays: null,
    });
    const { shelfId, shareToken } = created.data.shelf;

    const converted = await request(
      "PUT",
      `/api/user/${USER_ID}/public-shelf/${shelfId}`,
      { body: JSON.stringify({ expiresDays: 7 }), token: AUTH_TOKEN },
    );
    expect(converted.status).toBe(200);

    const snapshot = (await kv.get(
      kvKeys.publicShelf(shareToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(snapshot.expiresAt).not.toBeNull();

    const ops = watchKvOps();
    const res = await request("GET", `/api/public/${shareToken}`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.title).toBe("我的公開書櫃");
    expect(json.data.expiresAt).toBe(snapshot.expiresAt);
    // No owner-record read: guard 2 owns a snapshot that has a deadline.
    expect(ops.getKeys()).toEqual([kvKeys.publicShelf(shareToken)]);
  });

  it("reads only the snapshot for a time-limited shelf", async () => {
    // The record is seeded and LIVE on purpose: an unconditional liveness check
    // would still answer 200 here, so only the read count catches it.
    await seedSnapshot(TIMED_TOKEN, Date.now() + DAY_MS);
    await seedUserWithShelves(USER_ID, [shelfEntry(SHELF_ID, TIMED_TOKEN)]);
    const ops = watchKvOps();

    const res = await request("GET", `/api/public/${TIMED_TOKEN}`);

    expect(res.status).toBe(200);
    // KV TTL + the expiresAt backstop already cover a time-limited snapshot; it
    // must not pay for a third guard on every public read.
    expect(ops.getKeys()).toEqual([kvKeys.publicShelf(TIMED_TOKEN)]);
  });

  it("pays exactly one extra read for a permanent shelf", async () => {
    await seedSnapshot(PERM_TOKEN, null);
    await seedUserWithShelves(USER_ID, [shelfEntry(SHELF_ID, PERM_TOKEN)]);
    const ops = watchKvOps();

    const res = await request("GET", `/api/public/${PERM_TOKEN}`);

    expect(res.status).toBe(200);
    expect(ops.getKeys()).toEqual([
      kvKeys.publicShelf(PERM_TOKEN),
      kvKeys.user(USER_ID),
    ]);
    expect(ops.putKeys()).toEqual([]);
    expect(ops.deleteKeys()).toEqual([]);
  });

  it("still serves a time-limited orphan until its deadline passes", async () => {
    // Documented scope limit, pinned so it stays a decision rather than drift:
    // the guard is permanent-only, so a time-limited snapshot whose shelf is
    // already gone keeps serving until KV TTL / expiresAt retires it.
    await seedSnapshot(TIMED_TOKEN, Date.now() + DAY_MS);

    const res = await request("GET", `/api/public/${TIMED_TOKEN}`);

    expect(res.status).toBe(200);
  });
});

// ── PUT /api/user/:id/books — snapshot sync side-effect ───────

describe("PUT /api/user/:id/books side-effect", () => {
  it("updates public snapshot when books change", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shareToken = created.data.shelf.shareToken;

    // Verify initial snapshot has 2 shared books
    const snap1 = (await kv.get(
      kvKeys.publicShelf(shareToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(snap1.books).toHaveLength(2);

    // Update books: make book2 shared, book1 unshared
    const updatedBooks = sampleBooks();
    updatedBooks[0].isShared = BoolFlag.FALSE;
    updatedBooks[1].isShared = BoolFlag.TRUE;

    const res = await request("PUT", `/api/user/${USER_ID}/books`, {
      body: JSON.stringify({
        schemaVersion: 1,
        userId: USER_ID,
        displayName: "Test User",
        books: updatedBooks,
      }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);

    // Verify snapshot updated
    const snap2 = (await kv.get(
      kvKeys.publicShelf(shareToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(snap2.books).toHaveLength(2);
    const snapshotBookIds = snap2.books.map((b: Json) => b.bookId).sort();
    expect(snapshotBookIds).toEqual(["book2", "book3"]);
  });

  it("preserves publicSharing field when not in body", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await createShelf(USER_ID, AUTH_TOKEN);

    const res = await request("PUT", `/api/user/${USER_ID}/books`, {
      body: JSON.stringify({
        schemaVersion: 1,
        userId: USER_ID,
        displayName: "Test User",
        books: sampleBooks(),
      }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);

    const record = (await kv.get(
      kvKeys.user(USER_ID),
      "json",
    )) as UserBooksRecord;
    expect(record.publicSharing?.shelves).toHaveLength(1);
  });
});

// ── PATCH /api/user/:id/books — snapshot sync side-effect ────

describe("PATCH /api/user/:id/books side-effect", () => {
  it("updates public snapshot when isShared changes via PATCH", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shareToken = created.data.shelf.shareToken;

    // Initial snapshot: book1 (shared) + book3 (shared) = 2
    const snap1 = (await kv.get(
      kvKeys.publicShelf(shareToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(snap1.books).toHaveLength(2);
    expect(snap1.books.map((b: Json) => b.bookId).sort()).toEqual([
      "book1",
      "book3",
    ]);

    // PATCH: unshare book1, share book2
    const res = await request("PATCH", `/api/user/${USER_ID}/books`, {
      body: JSON.stringify({
        changes: [
          { bookId: "book1", isShared: 0 },
          { bookId: "book2", isShared: 1 },
        ],
      }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);
    expect(json.data.applied).toBe(2);

    // Verify snapshot updated: book2 (now shared) + book3 (still shared)
    const snap2 = (await kv.get(
      kvKeys.publicShelf(shareToken),
      "json",
    )) as PublicShelfSnapshot;
    expect(snap2.books).toHaveLength(2);
    expect(snap2.books.map((b: Json) => b.bookId).sort()).toEqual([
      "book2",
      "book3",
    ]);
  });

  it("preserves publicSharing field after PATCH", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    await createShelf(USER_ID, AUTH_TOKEN);

    const res = await request("PATCH", `/api/user/${USER_ID}/books`, {
      body: JSON.stringify({
        changes: [{ bookId: "book1", isShared: 0 }],
      }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);

    const record = (await kv.get(
      kvKeys.user(USER_ID),
      "json",
    )) as UserBooksRecord;
    expect(record.publicSharing?.shelves).toHaveLength(1);
  });
});

// ── DELETE /api/user/:id — cleanup ────────────────────────────

describe("DELETE /api/user/:id — public shelf cleanup", () => {
  it("deletes public shelf KV entries when user is deleted", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shareToken = created.data.shelf.shareToken;

    // Verify snapshot exists
    expect(await kv.get(kvKeys.publicShelf(shareToken))).not.toBeNull();

    const res = await request("DELETE", `/api/user/${USER_ID}`, {
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);

    // Verify snapshot cleaned up
    expect(await kv.get(kvKeys.publicShelf(shareToken))).toBeNull();
  });
});

// ── Auth refresh — familyId optional ──────────────────────────

describe("POST /api/auth/refresh — familyId optional", () => {
  it("refreshes token with familyId (backward-compatible)", async () => {
    const familyId = "abcd-1234";
    await seedUser(USER_ID, AUTH_TOKEN);
    await seedMember(USER_ID, familyId);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: USER_ID, familyId }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refreshes token without familyId (new behavior)", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: USER_ID }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns 401 when familyId provided but not a member", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: USER_ID, familyId: "abcd-1234" }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REFRESH_FAILED");
  });

  it("returns 401 without auth token", async () => {
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: USER_ID }),
    });

    expect(res.status).toBe(401);
  });
});
