import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { BoolFlag, kvKeys, type UserBooksRecord, type BookEntry } from "../../src/kv/schema";
import { generateAuthToken } from "../../src/middleware/auth";
import { USER1 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Non-dev request (rate limits active). */
function prodRequest(method: string, path: string, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return app.request(path, { method, headers }, { KV: kv });
}

function book(bookId: string, isShared: BoolFlag): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared,
  };
}

/** Seed a family with USER1 as sole owner + a user record with the given books. */
async function seedSoloFamily(books: BookEntry[]): Promise<{ familyId: string; token: string }> {
  const familyId = "abcd-1234";
  const token = await generateAuthToken(kv, USER1);
  await kv.put(kvKeys.member(USER1), familyId);
  await kv.put(
    kvKeys.family(familyId),
    JSON.stringify({
      familyId,
      ownerId: USER1,
      members: [{ userId: USER1, displayName: "Owner", canLend: BoolFlag.TRUE }],
      maxMembers: 2,
      createdAt: new Date().toISOString(),
    }),
  );
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId: USER1,
    displayName: "Owner",
    books,
    lastUpdated: new Date().toISOString(),
  };
  await kv.put(kvKeys.user(USER1), JSON.stringify(record));
  return { familyId, token };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// TEST-1: privacy filter — unshared books MUST be excluded from aggregation.
// This fails if someone deletes the `.filter(... === BoolFlag.TRUE)` line.
// ===========================================================================

describe("GET /api/family/:id/bookshelf — privacy filter", () => {
  it("returns ONLY shared books and omits every unshared book from a mixed shelf", async () => {
    const { familyId, token } = await seedSoloFamily([
      book("shared-1", BoolFlag.TRUE),
      book("private-1", BoolFlag.FALSE),
      book("shared-2", BoolFlag.TRUE),
      book("private-2", BoolFlag.FALSE),
    ]);

    const res = await request("GET", `/api/family/${familyId}/bookshelf`, undefined, token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;

    const returnedIds: string[] = json.data.members[0].books.map((b: BookEntry) => b.bookId);

    // Shared books present …
    expect(returnedIds).toContain("shared-1");
    expect(returnedIds).toContain("shared-2");
    // … unshared books absent.
    expect(returnedIds).not.toContain("private-1");
    expect(returnedIds).not.toContain("private-2");
    // Exactly the two shared ones, nothing else leaked.
    expect(returnedIds).toHaveLength(2);
  });

  it("returns an empty book list when the member has no shared books", async () => {
    const { familyId, token } = await seedSoloFamily([
      book("private-1", BoolFlag.FALSE),
      book("private-2", BoolFlag.FALSE),
    ]);

    const res = await request("GET", `/api/family/${familyId}/bookshelf`, undefined, token);
    const json = (await res.json()) as Json;
    expect(json.data.members[0].books).toEqual([]);
  });
});

// ===========================================================================
// BE-3: per-user rate limit on the bookshelf endpoint (max 30 / 60s window).
// Mirrors the borrow-list per-user rate-limit guard.
// ===========================================================================

describe("GET /api/family/:id/bookshelf — per-user rate limit", () => {
  it("rate-limits a single authenticated user after 30 requests within the window", async () => {
    const { familyId, token } = await seedSoloFamily([book("shared-1", BoolFlag.TRUE)]);

    // 30 requests all succeed.
    for (let i = 0; i < 30; i++) {
      const res = await prodRequest("GET", `/api/family/${familyId}/bookshelf`, token);
      expect(res.status).toBe(200);
    }

    // 31st request is rate-limited.
    const blocked = await prodRequest("GET", `/api/family/${familyId}/bookshelf`, token);
    expect(blocked.status).toBe(429);
    const json = (await blocked.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});
