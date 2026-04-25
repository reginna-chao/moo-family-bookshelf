import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";
import { generateAuthToken } from "../../src/middleware/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

function rawRequest(method: string, path: string, rawBody: string, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return app.request(
    path,
    { method, headers, body: rawBody },
    { KV: kv, DEV_MODE: "1" },
  );
}

async function createFamilyAndGetToken(userId = "user1") {
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

// ===========================================================================
// GET /api/user/:id/books — validation and authorization
// ===========================================================================

describe("GET /api/user/:id/books", () => {
  it("should return 401 UNAUTHORIZED when no auth token is provided", async () => {
    const res = await request("GET", "/api/user/user1/books");
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_USER_ID for invalid userId", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("GET", "/api/user/user<script>/books", undefined, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 403 FORBIDDEN when accessing another user's books", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("GET", "/api/user/user2/books", undefined, authToken);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return data when user has books", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    // Save books first
    const personalBooks = {
      schemaVersion: 1,
      userId: "user1",
      displayName: "Test",
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 0 }],
    };
    await request("PUT", "/api/user/user1/books", personalBooks, authToken);

    // Then retrieve
    const res = await request("GET", "/api/user/user1/books", undefined, authToken);
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
    const res = await request("PUT", "/api/user/user1/books", { books: [] });
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_USER_ID for invalid userId on PUT", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user<script>/books", { books: [] }, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 403 FORBIDDEN when modifying another user's books", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user2/books", { books: [] }, authToken);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 INVALID_JSON for malformed request body on PUT", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await rawRequest("PUT", "/api/user/user1/books", "{not valid}", authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 400 INVALID_PAYLOAD when books is not an array", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user1/books", { books: "not-array" }, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when books is missing", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user1/books", {}, authToken);
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

  function prodRequest(method: string, path: string, body?: unknown, authToken?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
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
      const res = await prodRequest("PUT", `/api/user/${TEST_USER}/books`, validBody, token);
      expect(res.status).toBe(200);
    }

    const res = await prodRequest("PUT", `/api/user/${TEST_USER}/books`, validBody, token);
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
    const blockedA = await prodRequest("PUT", `/api/user/${userA}/books`, validBody, tokenA);
    expect(blockedA.status).toBe(429);

    // userB should still work
    const resB = await prodRequest("PUT", `/api/user/${userB}/books`, validBody, tokenB);
    expect(resB.status).toBe(200);
  });

  it("should not consume per-user quota on unauthenticated requests", async () => {
    // No auth → 401 (before per-user rate limit runs)
    const res = await prodRequest("PUT", `/api/user/${TEST_USER}/books`, validBody);
    expect(res.status).toBe(401);

    // Verify no rate limit key was created
    const keys = await kv.list();
    const rateLimitKeys = keys.keys.filter(
      (k: { name: string }) => k.name.startsWith("ratelimit:user:put-books:"),
    );
    expect(rateLimitKeys).toHaveLength(0);
  });

  it("should bypass per-user rate limit in dev mode", async () => {
    // Use the existing dev-mode request helper (has DEV_MODE: "1")
    const { authToken } = await createFamilyAndGetToken("user1");
    for (let i = 0; i < 31; i++) {
      const res = await request("PUT", "/api/user/user1/books", validBody, authToken);
      expect(res.status).toBe(200);
    }
  });
});
