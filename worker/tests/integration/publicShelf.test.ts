import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { BoolFlag, kvKeys, type UserBooksRecord, type PublicShelfSnapshot } from "../../src/kv/schema";

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
  await kv.put(`token:${token}`, userId);
  await kv.put(`auth:${userId}`, JSON.stringify({ token, createdAt: new Date().toISOString() }));
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

    const snapshot = await kv.get(kvKeys.publicShelf(token), "json") as PublicShelfSnapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot.books).toHaveLength(2);
    expect(snapshot.books.every((b: Json) => b.isShared === BoolFlag.TRUE)).toBe(true);
    expect(snapshot.title).toBe("我的公開書櫃");
  });

  it("creates a permanent shelf (expiresDays=null)", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const { res, json } = await createShelf(USER_ID, AUTH_TOKEN, { expiresDays: null });

    expect(res.status).toBe(201);
    expect(json.data.shelf.expiresDays).toBeNull();
    expect(json.data.shelf.expiresAt).toBeNull();

    const snapshot = await kv.get(kvKeys.publicShelf(json.data.shelf.shareToken), "json") as PublicShelfSnapshot;
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

    const { res, json } = await createShelf(USER_ID, AUTH_TOKEN, { title: "Second" });

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("MAX_SHELVES_REACHED");
  });

  it("returns 400 when user has no books record", async () => {
    await kv.put(`token:${AUTH_TOKEN}`, USER_ID);
    await kv.put(`auth:${USER_ID}`, JSON.stringify({ token: AUTH_TOKEN, createdAt: new Date().toISOString() }));

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

    const res = await request("PUT", `/api/user/${USER_ID}/public-shelf/${shelfId}`, {
      body: JSON.stringify({ title: "新標題" }),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.shelf.title).toBe("新標題");

    const snapshot = await kv.get(kvKeys.publicShelf(shareToken), "json") as PublicShelfSnapshot;
    expect(snapshot.title).toBe("新標題");
  });

  it("updates expiresDays and recalculates expiresAt from now", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN, { expiresDays: 30 });
    const shelfId = created.data.shelf.shelfId;

    const before = Date.now();
    const res = await request("PUT", `/api/user/${USER_ID}/public-shelf/${shelfId}`, {
      body: JSON.stringify({ expiresDays: 90 }),
      token: AUTH_TOKEN,
    });
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

    const res = await request("PUT", `/api/user/${USER_ID}/public-shelf/${created.data.shelf.shelfId}`, {
      body: JSON.stringify({}),
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 404 for non-existent shelfId", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const fakeShelfId = "12345678-1234-4123-8123-123456789abc";
    const res = await request("PUT", `/api/user/${USER_ID}/public-shelf/${fakeShelfId}`, {
      body: JSON.stringify({ title: "Test" }),
      token: AUTH_TOKEN,
    });

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

    const res = await request("POST", `/api/user/${USER_ID}/public-shelf/${shelfId}/reset-token`, {
      token: AUTH_TOKEN,
    });

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

    const res = await request("POST", `/api/user/${USER_ID}/public-shelf/${shelfId}/reset-token`, {
      token: AUTH_TOKEN,
    });
    const json = (await res.json()) as Json;
    const newToken = json.data.shelf.shareToken;

    const oldSnapshot = await kv.get(kvKeys.publicShelf(oldToken));
    expect(oldSnapshot).toBeNull();

    const newSnapshot = await kv.get(kvKeys.publicShelf(newToken), "json") as PublicShelfSnapshot;
    expect(newSnapshot).not.toBeNull();
    expect(newSnapshot.books).toHaveLength(2);
  });

  it("returns 404 for non-existent shelfId", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const fakeShelfId = "12345678-1234-4123-8123-123456789abc";
    const res = await request("POST", `/api/user/${USER_ID}/public-shelf/${fakeShelfId}/reset-token`, {
      token: AUTH_TOKEN,
    });

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

    const res = await request("DELETE", `/api/user/${USER_ID}/public-shelf/${shelfId}`, {
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(204);

    const record = await kv.get(kvKeys.user(USER_ID), "json") as UserBooksRecord;
    expect(record.publicSharing?.shelves).toHaveLength(0);

    const snapshot = await kv.get(kvKeys.publicShelf(shareToken));
    expect(snapshot).toBeNull();
  });

  it("returns 404 for non-existent shelfId", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);

    const fakeShelfId = "12345678-1234-4123-8123-123456789abc";
    const res = await request("DELETE", `/api/user/${USER_ID}/public-shelf/${fakeShelfId}`, {
      token: AUTH_TOKEN,
    });

    expect(res.status).toBe(404);
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

    const res = await request("GET", `/api/public/${created.data.shelf.shareToken}`);
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

// ── PUT /api/user/:id/books — snapshot sync side-effect ───────

describe("PUT /api/user/:id/books side-effect", () => {
  it("updates public snapshot when books change", async () => {
    await seedUser(USER_ID, AUTH_TOKEN);
    const { json: created } = await createShelf(USER_ID, AUTH_TOKEN);
    const shareToken = created.data.shelf.shareToken;

    // Verify initial snapshot has 2 shared books
    const snap1 = await kv.get(kvKeys.publicShelf(shareToken), "json") as PublicShelfSnapshot;
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
    const snap2 = await kv.get(kvKeys.publicShelf(shareToken), "json") as PublicShelfSnapshot;
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

    const record = await kv.get(kvKeys.user(USER_ID), "json") as UserBooksRecord;
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
