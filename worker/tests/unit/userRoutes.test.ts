import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { BoolFlag, kvKeys } from "../../src/kv/schema";
import { generateAuthToken } from "../../src/middleware/auth";
import { ALICE, USER1, USER2, USER3, USER4, USER5 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

function rawRequest(
  method: string,
  path: string,
  rawBody: string,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return app.request(
    path,
    { method, headers, body: rawBody },
    { KV: kv, DEV_MODE: "1" },
  );
}

async function createFamilyAndGetToken(userId = USER1) {
  const res = await request("POST", "/api/family", { userId });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

beforeEach(() => {
  kv = createMockKV();
});

// `watchKvOps` installs `vi.spyOn` handlers and does not clean up after itself.
afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// GET /api/user/:id/books — validation and authorization
// ===========================================================================

describe("GET /api/user/:id/books", () => {
  it("should return 401 UNAUTHORIZED when no auth token is provided", async () => {
    const res = await request("GET", `/api/user/${USER1}/books`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_USER_ID for invalid userId", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "GET",
      "/api/user/user<script>/books",
      undefined,
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 403 FORBIDDEN when accessing another user's books", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "GET",
      `/api/user/${USER2}/books`,
      undefined,
      authToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return data when user has books", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    // Save books first
    const personalBooks = {
      schemaVersion: 1,
      userId: USER1,
      displayName: "Test",
      books: [
        {
          bookId: "b1",
          title: "Book 1",
          author: "",
          isbn: "",
          coverUrl: "",
          readmooUrl: "",
          category: "",
          isShared: 0,
        },
      ],
    };
    await request("PUT", `/api/user/${USER1}/books`, personalBooks, authToken);

    // Then retrieve
    const res = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.books).toHaveLength(1);
    expect(json.data.books[0].bookId).toBe("b1");
    expect(json.data.lastUpdated).toBeDefined();
  });
});

// ===========================================================================
// PUT /api/user/:id/books — validation and authorization
// ===========================================================================

describe("PUT /api/user/:id/books", () => {
  it("should return 401 UNAUTHORIZED when no auth token is provided", async () => {
    const res = await request("PUT", `/api/user/${USER1}/books`, { books: [] });
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_USER_ID for invalid userId on PUT", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PUT",
      "/api/user/user<script>/books",
      { books: [] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 403 FORBIDDEN when modifying another user's books", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER2}/books`,
      { books: [] },
      authToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 INVALID_JSON for malformed request body on PUT", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await rawRequest(
      "PUT",
      `/api/user/${USER1}/books`,
      "{not valid}",
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 400 INVALID_PAYLOAD when books is not an array", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      { books: "not-array" },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when books is missing", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request("PUT", `/api/user/${USER1}/books`, {}, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });
});

// ===========================================================================
// PUT /api/user/:id/books — per-user rate limit (non-dev mode)
// ===========================================================================

describe("PUT /:id/books per-user rate limit", () => {
  const TEST_USER = "a".repeat(64);
  const validBody = { books: [] };

  function prodRequest(
    method: string,
    path: string,
    body?: unknown,
    authToken?: string,
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return app.request(path, init, { KV: kv });
  }

  async function seedAuth(userId: string): Promise<string> {
    return generateAuthToken(kv, userId);
  }

  it("should return 429 after 30 PUTs per user per hour", async () => {
    const token = await seedAuth(TEST_USER);

    for (let i = 0; i < 30; i++) {
      const res = await prodRequest(
        "PUT",
        `/api/user/${TEST_USER}/books`,
        validBody,
        token,
      );
      expect(res.status).toBe(200);
    }

    const res = await prodRequest(
      "PUT",
      `/api/user/${TEST_USER}/books`,
      validBody,
      token,
    );
    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("should count independently per userId", async () => {
    const userA = "a".repeat(64);
    const userB = "b".repeat(64);
    const tokenA = await seedAuth(userA);
    const tokenB = await seedAuth(userB);

    // Exhaust userA's limit
    for (let i = 0; i < 30; i++) {
      await prodRequest("PUT", `/api/user/${userA}/books`, validBody, tokenA);
    }
    const blockedA = await prodRequest(
      "PUT",
      `/api/user/${userA}/books`,
      validBody,
      tokenA,
    );
    expect(blockedA.status).toBe(429);

    // userB should still work
    const resB = await prodRequest(
      "PUT",
      `/api/user/${userB}/books`,
      validBody,
      tokenB,
    );
    expect(resB.status).toBe(200);
  });

  it("should not consume per-user quota on unauthenticated requests", async () => {
    // No auth → 401 (before per-user rate limit runs)
    const res = await prodRequest(
      "PUT",
      `/api/user/${TEST_USER}/books`,
      validBody,
    );
    expect(res.status).toBe(401);

    // Verify no rate limit key was created
    const keys = await kv.list();
    const rateLimitKeys = keys.keys.filter((k: { name: string }) =>
      k.name.startsWith("ratelimit:user:put-books:"),
    );
    expect(rateLimitKeys).toHaveLength(0);
  });

  it("should bypass per-user rate limit in dev mode", async () => {
    // Use the existing dev-mode request helper (has DEV_MODE: "1")
    const { authToken } = await createFamilyAndGetToken(USER1);
    for (let i = 0; i < 31; i++) {
      const res = await request(
        "PUT",
        `/api/user/${USER1}/books`,
        validBody,
        authToken,
      );
      expect(res.status).toBe(200);
    }
  });
});

// ===========================================================================
// PATCH /api/user/:id/books — validation and authorization
// ===========================================================================

describe("PATCH /api/user/:id/books", () => {
  const sampleBook = (id: string, isShared = 0) => ({
    bookId: id,
    title: `Book ${id}`,
    author: `Author ${id}`,
    isbn: `isbn-${id}`,
    coverUrl: `https://cdn.readmoo.com/${id}.jpg`,
    readmooUrl: `https://readmoo.com/book/${id}`,
    category: "fiction",
    isShared,
  });

  async function seedBooksForUser(
    userId: string,
    authToken: string,
    books = [sampleBook("b1"), sampleBook("b2"), sampleBook("b3")],
  ) {
    await request(
      "PUT",
      `/api/user/${userId}/books`,
      {
        schemaVersion: 1,
        userId,
        displayName: "Original Name",
        books,
      },
      authToken,
    );
  }

  // --- Auth & validation ---

  it("should return 401 UNAUTHORIZED when no auth token is provided", async () => {
    const res = await request("PATCH", `/api/user/${USER1}/books`, {
      changes: [{ bookId: "b1", isShared: 1 }],
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_USER_ID for invalid userId", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      "/api/user/user<script>/books",
      { changes: [{ bookId: "b1", isShared: 1 }] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 403 FORBIDDEN when patching another user's books", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER2}/books`,
      { changes: [{ bookId: "b1", isShared: 1 }] },
      authToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 INVALID_JSON for malformed body", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await rawRequest(
      "PATCH",
      `/api/user/${USER1}/books`,
      "{not valid json}",
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 400 INVALID_PAYLOAD when changes is missing", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      {},
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when changes is not an array", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: "not-array" },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when changes is empty array", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: [] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when changes exceeds 1000 entries", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const bigChanges = Array.from({ length: 1001 }, (_, i) => ({
      bookId: `b${i}`,
      isShared: 1,
    }));
    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: bigChanges },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when a change has empty bookId", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: [{ bookId: "", isShared: 1 }] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when a change has non-string bookId", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: [{ bookId: 123, isShared: 1 }] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when isShared is not 0 or 1", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: [{ bookId: "b1", isShared: 2 }] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when isShared is a string", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: [{ bookId: "b1", isShared: "yes" }] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when displayName is empty string", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedBooksForUser(USER1, authToken);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      {
        changes: [{ bookId: "b1", isShared: 1 }],
        displayName: "",
      },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 404 NOT_FOUND when user record does not exist", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    // Do NOT seed books — user record is absent

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      { changes: [{ bookId: "b1", isShared: 1 }] },
      authToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
  });

  // --- Happy path ---

  it("should apply changes and return applied count", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedBooksForUser(USER1, authToken);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      {
        changes: [
          { bookId: "b1", isShared: 1 },
          { bookId: "b2", isShared: 1 },
        ],
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);
    expect(json.data.applied).toBe(2);

    // Verify via GET
    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(
      getJson.data.books.find((b: Json) => b.bookId === "b1").isShared,
    ).toBe(1);
    expect(
      getJson.data.books.find((b: Json) => b.bookId === "b2").isShared,
    ).toBe(1);
    expect(
      getJson.data.books.find((b: Json) => b.bookId === "b3").isShared,
    ).toBe(0);
  });

  it("should silently skip unknown bookIds and not count them in applied", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedBooksForUser(USER1, authToken);

    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      {
        changes: [
          { bookId: "b1", isShared: 1 },
          { bookId: "nonexistent", isShared: 1 },
        ],
      },
      authToken,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.applied).toBe(1);

    // Verify b1 was updated
    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(
      getJson.data.books.find((b: Json) => b.bookId === "b1").isShared,
    ).toBe(1);
  });

  it("should update displayName when provided and user is not in a family", async () => {
    // Seed books directly via KV (not in a family)
    const token = await generateAuthToken(kv, USER3);
    const record = {
      schemaVersion: 1,
      userId: USER3,
      displayName: "Old Name",
      books: [sampleBook("b1")],
      lastUpdated: new Date().toISOString(),
    };
    await kv.put(kvKeys.user(USER3), JSON.stringify(record));

    const res = await request(
      "PATCH",
      `/api/user/${USER3}/books`,
      {
        changes: [{ bookId: "b1", isShared: 1 }],
        displayName: "New Name",
      },
      token,
    );

    expect(res.status).toBe(200);

    const getRes = await request(
      "GET",
      `/api/user/${USER3}/books`,
      undefined,
      token,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.displayName).toBe("New Name");
  });

  it("should NOT overwrite displayName when omitted from body", async () => {
    // Seed user directly (not in family) with a known displayName
    const token = await generateAuthToken(kv, USER4);
    const record = {
      schemaVersion: 1,
      userId: USER4,
      displayName: "Keep This Name",
      books: [sampleBook("b1"), sampleBook("b2")],
      lastUpdated: new Date().toISOString(),
    };
    await kv.put(kvKeys.user(USER4), JSON.stringify(record));

    // PATCH without displayName in body
    const res = await request(
      "PATCH",
      `/api/user/${USER4}/books`,
      {
        changes: [{ bookId: "b1", isShared: 1 }],
      },
      token,
    );

    expect(res.status).toBe(200);

    // Verify displayName was preserved from the original record
    const getRes = await request(
      "GET",
      `/api/user/${USER4}/books`,
      undefined,
      token,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.displayName).toBe("Keep This Name");
  });

  it("should preserve other book fields (title, author, coverUrl, etc.) when patching isShared", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    const originalBooks = [
      {
        bookId: "b1",
        title: "My Book",
        author: "Jane",
        isbn: "978-xxx",
        // Must be a whitelisted Readmoo cover host: the books write paths blank
        // anything else (see the coverUrl lazy-cleanup suite below), so an
        // arbitrary host here would test blanking, not field preservation.
        coverUrl: "https://cdn.readmoo.com/b1.jpg",
        readmooUrl: "https://readmoo.com/book/b1",
        category: "sci-fi",
        isShared: 0,
      },
    ];
    await seedBooksForUser(USER1, authToken, originalBooks);

    await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      {
        changes: [{ bookId: "b1", isShared: 1 }],
      },
      authToken,
    );

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    const book = getJson.data.books.find((b: Json) => b.bookId === "b1");
    expect(book.title).toBe("My Book");
    expect(book.author).toBe("Jane");
    expect(book.isbn).toBe("978-xxx");
    expect(book.coverUrl).toBe("https://cdn.readmoo.com/b1.jpg");
    expect(book.readmooUrl).toBe("https://readmoo.com/book/b1");
    expect(book.category).toBe("sci-fi");
    expect(book.isShared).toBe(1);
  });

  it("should refresh lastUpdated after PATCH", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedBooksForUser(USER1, authToken);

    // Get original lastUpdated
    const getRes1 = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson1 = (await getRes1.json()) as Json;
    const originalLastUpdated = getJson1.data.lastUpdated;

    // Small delay to ensure timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 10));

    await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      {
        changes: [{ bookId: "b1", isShared: 1 }],
      },
      authToken,
    );

    const getRes2 = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson2 = (await getRes2.json()) as Json;
    expect(getJson2.data.lastUpdated).not.toBe(originalLastUpdated);
  });

  // --- S1: displayName family-authoritative for family members ---

  it("should use family record displayName (not client value) when user is in a family", async () => {
    // Create family with a known displayName for user1
    const createRes = await request("POST", "/api/family", {
      userId: USER1,
      displayName: "Family Name",
    });
    const createJson = (await createRes.json()) as Json;
    const authToken = createJson.data.authToken as string;

    // Seed books for user1
    await seedBooksForUser(USER1, authToken);

    // PATCH with a client-supplied displayName that should be IGNORED
    const res = await request(
      "PATCH",
      `/api/user/${USER1}/books`,
      {
        changes: [{ bookId: "b1", isShared: 1 }],
        displayName: "Client Tried This",
      },
      authToken,
    );

    expect(res.status).toBe(200);

    // Verify displayName is from family record, not from client
    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.displayName).toBe("Family Name");
  });

  // --- S2: no-op PATCH short-circuits without KV write ---

  it("should not rewrite KV when all bookIds are unknown and no displayName provided", async () => {
    // Seed user directly with a fixed lastUpdated (not in a family)
    const token = await generateAuthToken(kv, USER5);
    const fixedTimestamp = "2020-01-01T00:00:00.000Z";
    const record = {
      schemaVersion: 1,
      userId: USER5,
      displayName: "NoOp User",
      books: [sampleBook("b1")],
      lastUpdated: fixedTimestamp,
    };
    await kv.put(kvKeys.user(USER5), JSON.stringify(record));

    // PATCH with a bookId that doesn't exist — no displayName
    const res = await request(
      "PATCH",
      `/api/user/${USER5}/books`,
      {
        changes: [{ bookId: "nonexistent", isShared: 1 }],
      },
      token,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);
    expect(json.data.applied).toBe(0);

    // Verify KV was NOT rewritten — lastUpdated should still be the original fixed timestamp
    const getRes = await request(
      "GET",
      `/api/user/${USER5}/books`,
      undefined,
      token,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.lastUpdated).toBe(fixedTimestamp);
  });
});

// ===========================================================================
// PATCH /api/user/:id/books — coverUrl lazy cleanup (P0 privacy)
//
// A book cover is fetched by every family member and every public-shelf
// visitor, so an attacker-chosen cover host acts as a tracking beacon. PUT
// blocks new ones at the boundary; PATCH additionally SCRUBS records written
// before that guard existed. The cleanup is opportunistic on purpose: it rides
// a write that was going to happen anyway and never forces one.
// ===========================================================================

describe("PATCH /api/user/:id/books — coverUrl lazy cleanup", () => {
  const LEGACY_USER = ALICE;
  const POISONED_COVER = "https://evil.example.com/beacon.gif";
  const POISONED_HOST = "evil.example.com";
  const CLEAN_COVER = "https://cdn.readmoo.com/clean.jpg";
  /** Fixed so "the record was not rewritten" is provable from `lastUpdated`. */
  const SEEDED_AT = "2020-01-01T00:00:00.000Z";

  function book(bookId: string, coverUrl: string, isShared = BoolFlag.FALSE) {
    return {
      bookId,
      title: `Book ${bookId}`,
      author: "",
      isbn: "",
      coverUrl,
      readmooUrl: "",
      category: "",
      isShared,
    };
  }

  /**
   * Seed `user:{id}` DIRECTLY rather than through PUT. A poisoned coverUrl can
   * only be in KV because it was written BEFORE the whitelist existed — PUT
   * sanitizes on the way in, so it cannot produce this fixture.
   */
  async function seedLegacyRecord(
    books: ReturnType<typeof book>[],
  ): Promise<string> {
    await kv.put(
      kvKeys.user(LEGACY_USER),
      JSON.stringify({
        schemaVersion: 1,
        userId: LEGACY_USER,
        displayName: "Legacy User",
        books,
        lastUpdated: SEEDED_AT,
      }),
    );
    return generateAuthToken(kv, LEGACY_USER);
  }

  async function storedRecord(): Promise<Json> {
    return kv.get(kvKeys.user(LEGACY_USER), "json");
  }

  function patch(body: unknown, token: string) {
    return request("PATCH", `/api/user/${LEGACY_USER}/books`, body, token);
  }

  it("scrubs the poisoned cover of the book a change targets, keeping a whitelisted one", async () => {
    const token = await seedLegacyRecord([
      book("b1", POISONED_COVER),
      book("b2", CLEAN_COVER),
    ]);

    const res = await patch(
      { changes: [{ bookId: "b1", isShared: BoolFlag.TRUE }] },
      token,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.applied).toBe(1);

    const record = await storedRecord();
    const [b1, b2] = record.books;
    expect(b1.coverUrl).toBe("");
    expect(b1.isShared).toBe(BoolFlag.TRUE);
    expect(b2.coverUrl).toBe(CLEAN_COVER);
    expect(JSON.stringify(record)).not.toContain(POISONED_HOST);
  });

  it("scrubs the poisoned cover of a book no change targets", async () => {
    const token = await seedLegacyRecord([
      book("b1", CLEAN_COVER),
      book("b2", POISONED_COVER),
    ]);

    const res = await patch(
      { changes: [{ bookId: "b1", isShared: BoolFlag.TRUE }] },
      token,
    );
    expect(res.status).toBe(200);

    const record = await storedRecord();
    const untouched = record.books.find((b: Json) => b.bookId === "b2");
    expect(untouched.coverUrl).toBe("");
    // Only the cover moved: the book's own sharing state is not a change target.
    expect(untouched.isShared).toBe(BoolFlag.FALSE);
    expect(untouched.title).toBe("Book b2");
  });

  it("counts only requested isShared changes in `applied`, never sanitize rewrites", async () => {
    const token = await seedLegacyRecord([
      book("b1", POISONED_COVER),
      book("b2", POISONED_COVER),
    ]);

    const res = await patch(
      { changes: [{ bookId: "b1", isShared: BoolFlag.TRUE }] },
      token,
    );

    // Two books were rewritten, but only one change was requested.
    expect(((await res.json()) as Json).data.applied).toBe(1);
    const record = await storedRecord();
    expect(record.books.map((b: Json) => b.coverUrl)).toEqual(["", ""]);
  });

  it("leaves a poisoned cover in KV when the PATCH is a pure no-op", async () => {
    const token = await seedLegacyRecord([book("b1", POISONED_COVER)]);
    const ops = watchKvOps(kv);

    const res = await patch(
      { changes: [{ bookId: "unknown-book", isShared: BoolFlag.TRUE }] },
      token,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.applied).toBe(0);

    // The short-circuit still skips the KV write entirely — cleanup rides an
    // existing write and must never become a hidden one of its own.
    expect(ops.putKeys()).toEqual([]);
    const record = await storedRecord();
    expect(record.books[0].coverUrl).toBe(POISONED_COVER);
    expect(record.lastUpdated).toBe(SEEDED_AT);
  });

  it("scrubs poisoned covers on a displayName-only PATCH, which writes anyway", async () => {
    const token = await seedLegacyRecord([book("b1", POISONED_COVER)]);

    const res = await patch(
      {
        changes: [{ bookId: "unknown-book", isShared: BoolFlag.TRUE }],
        displayName: "New Name",
      },
      token,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.applied).toBe(0);

    const record = await storedRecord();
    expect(record.books[0].coverUrl).toBe("");
    expect(record.displayName).toBe("New Name");
    expect(record.lastUpdated).not.toBe(SEEDED_AT);
  });
});

// ===========================================================================
// PATCH /api/user/:id/books — per-user rate limit (shared bucket with PUT)
// ===========================================================================

describe("PATCH /:id/books per-user rate limit", () => {
  const TEST_USER = "c".repeat(64);

  function prodRequest(
    method: string,
    path: string,
    body?: unknown,
    authToken?: string,
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return app.request(path, init, { KV: kv });
  }

  async function seedAuth(userId: string): Promise<string> {
    return generateAuthToken(kv, userId);
  }

  it("should share the rate limit bucket with PUT — 29 PUTs + 1 PATCH = ok, then 1 more PATCH = 429", async () => {
    const token = await seedAuth(TEST_USER);
    const validPutBody = { books: [] };
    const validPatchBody = { changes: [{ bookId: "b1", isShared: 1 }] };

    // Seed a user record so PATCH has something to work with
    await kv.put(
      kvKeys.user(TEST_USER),
      JSON.stringify({
        schemaVersion: 1,
        userId: TEST_USER,
        displayName: "Test",
        books: [
          {
            bookId: "b1",
            title: "Book",
            author: "",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: 0,
          },
        ],
        lastUpdated: new Date().toISOString(),
      }),
    );

    // 29 PUTs (all succeed)
    for (let i = 0; i < 29; i++) {
      const res = await prodRequest(
        "PUT",
        `/api/user/${TEST_USER}/books`,
        validPutBody,
        token,
      );
      expect(res.status).toBe(200);
    }

    // 1 PATCH (30th request — should succeed)
    const patchOk = await prodRequest(
      "PATCH",
      `/api/user/${TEST_USER}/books`,
      validPatchBody,
      token,
    );
    expect(patchOk.status).toBe(200);

    // 1 more PATCH (31st request — should be rate limited)
    const patchBlocked = await prodRequest(
      "PATCH",
      `/api/user/${TEST_USER}/books`,
      validPatchBody,
      token,
    );
    expect(patchBlocked.status).toBe(429);
    const json = (await patchBlocked.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(patchBlocked.headers.get("Retry-After")).toBeTruthy();
  });
});
