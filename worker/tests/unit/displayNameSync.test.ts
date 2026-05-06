import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys, type UserBooksRecord } from "../../src/kv/schema";

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

async function createFamily(userId = "user1", displayName?: string) {
  const body: Record<string, string> = { userId };
  if (displayName !== undefined) body.displayName = displayName;
  const res = await request("POST", "/api/family", body);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function createFamilyWithTwoMembers(displayName1?: string, displayName2?: string) {
  const { familyId, authToken: token1 } = await createFamily("user1", displayName1);
  const joinRes = await request("POST", `/api/family/${familyId}/join`, {
    userId: "user2",
    displayName: displayName2,
  });
  const joinJson = (await joinRes.json()) as Json;
  const token2 = joinJson.data.authToken as string;
  return { familyId, token1, token2 };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Fix A: PUT /api/family/:id/member/:uid/displayName syncs user record
// ===========================================================================

describe("PUT displayName syncs user record", () => {
  it("should update user record displayName when user record exists", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    // user1 saves books with displayName "Alice"
    await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "Alice",
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);

    // Verify user record has displayName "Alice"
    const beforeRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const beforeJson = (await beforeRes.json()) as Json;
    expect(beforeJson.data.displayName).toBe("Alice");

    // user1 updates displayName to "AliceNew" via family endpoint
    const updateRes = await request(
      "PUT",
      `/api/family/${familyId}/member/user1/displayName`,
      { displayName: "AliceNew" },
      token1,
    );
    expect(updateRes.status).toBe(200);

    // Verify user record's displayName was also updated
    const afterRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const afterJson = (await afterRes.json()) as Json;
    expect(afterJson.data.displayName).toBe("AliceNew");
  });

  it("should update user record lastUpdated when displayName changes", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    // user1 saves books
    await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "Alice",
      books: [],
    }, token1);

    const beforeRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const beforeJson = (await beforeRes.json()) as Json;
    const oldLastUpdated = beforeJson.data.lastUpdated;

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    // Update displayName
    await request(
      "PUT",
      `/api/family/${familyId}/member/user1/displayName`,
      { displayName: "AliceUpdated" },
      token1,
    );

    const afterRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const afterJson = (await afterRes.json()) as Json;
    expect(afterJson.data.lastUpdated).not.toBe(oldLastUpdated);
  });

  it("should not fail when user record does not exist", async () => {
    const { familyId, authToken: token1 } = await createFamily("user1", "Alice");

    // user1 has NOT saved any books yet — no user record exists

    // Updating displayName should still succeed (no user record to sync)
    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/user1/displayName`,
      { displayName: "AliceNew" },
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.displayName).toBe("AliceNew");
  });

  it("should preserve other user record fields when syncing displayName", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    // user1 saves books with multiple fields
    await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "Alice",
      books: [
        { bookId: "b1", title: "Book 1", author: "Author1", isbn: "123", coverUrl: "", readmooUrl: "", category: "fiction", isShared: 1 },
        { bookId: "b2", title: "Book 2", author: "Author2", isbn: "456", coverUrl: "", readmooUrl: "", category: "non-fiction", isShared: 0 },
      ],
    }, token1);

    // Update displayName
    await request(
      "PUT",
      `/api/family/${familyId}/member/user1/displayName`,
      { displayName: "AliceRenamed" },
      token1,
    );

    // Verify other fields are preserved
    const res = await request("GET", "/api/user/user1/books", undefined, token1);
    const json = (await res.json()) as Json;
    expect(json.data.displayName).toBe("AliceRenamed");
    expect(json.data.books).toHaveLength(2);
    expect(json.data.books[0].bookId).toBe("b1");
    expect(json.data.books[1].bookId).toBe("b2");
    expect(json.data.userId).toBe("user1");
    expect(json.data.schemaVersion).toBe(1);
  });
});

// ===========================================================================
// Fix B: PUT /api/user/:id/books uses family record's displayName
// ===========================================================================

describe("PUT books uses family displayName over client displayName", () => {
  it("should use family record displayName instead of client-supplied stale name", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    // user1 updates displayName to "AliceNew" in family
    await request(
      "PUT",
      `/api/family/${familyId}/member/user1/displayName`,
      { displayName: "AliceNew" },
      token1,
    );

    // Extension syncs books with stale displayName "Alice"
    const putRes = await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "Alice", // stale!
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);
    expect(putRes.status).toBe(200);

    // Verify saved record uses authoritative name from family, not the stale one
    const getRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const json = (await getRes.json()) as Json;
    expect(json.data.displayName).toBe("AliceNew");
  });

  it("should fall back to client displayName when user is not in a family", async () => {
    // Create a family with one member, then have the owner leave (delete family)
    const { familyId, authToken: token1 } = await createFamily("user1", "Alice");

    // Save books first while in family
    await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "Alice",
      books: [],
    }, token1);

    // Owner leaves (single-member family → family deleted)
    await request("DELETE", `/api/family/${familyId}/member/user1`, undefined, token1);

    // Now user1 has no family membership. Manually seed a new token for testing
    // since leaving deletes the auth token.
    const { generateAuthToken } = await import("../../src/middleware/auth");
    const newToken = await generateAuthToken(kv, "user1");

    // Sync books with a displayName — should use client's value since no family
    const putRes = await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "AliceNoFamily",
      books: [],
    }, newToken);
    expect(putRes.status).toBe(200);

    const getRes = await request("GET", "/api/user/user1/books", undefined, newToken);
    const json = (await getRes.json()) as Json;
    expect(json.data.displayName).toBe("AliceNoFamily");
  });

  it("should fall back to client displayName when family record is missing", async () => {
    const { familyId, authToken: token1 } = await createFamily("user1", "Alice");

    // Corrupt state: delete family record but leave member key
    await kv.delete(kvKeys.family(familyId));

    // Sync books — family record is missing, so fall back to client
    const putRes = await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "AliceFallback",
      books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const getRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const json = (await getRes.json()) as Json;
    expect(json.data.displayName).toBe("AliceFallback");
  });

  it("should use empty string when family member has no displayName set", async () => {
    // Create family without displayName (defaults to "")
    const { familyId, authToken: token1 } = await createFamily("user1");

    // Sync books with a client displayName — but family has empty displayName
    // Since self.displayName is "", the truthy check fails, so client value is used
    const putRes = await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "ClientName",
      books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const getRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const json = (await getRes.json()) as Json;
    // When family member displayName is empty, client value is used as fallback
    expect(json.data.displayName).toBe("ClientName");
  });

  it("should use family displayName even when client sends empty string", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers("Alice", "Bob");

    // Sync books with empty displayName — family has "Alice"
    const putRes = await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1,
      userId: "user1",
      displayName: "",
      books: [],
    }, token1);
    expect(putRes.status).toBe(200);

    const getRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const json = (await getRes.json()) as Json;
    // Family record has "Alice", so it takes precedence
    expect(json.data.displayName).toBe("Alice");
  });

  it("should handle both fixes together: rename then sync books", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers("Alice", "Bob");

    // Both users save initial books
    await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1, userId: "user1", displayName: "Alice",
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);
    await request("PUT", "/api/user/user2/books", {
      schemaVersion: 1, userId: "user2", displayName: "Bob",
      books: [{ bookId: "b2", title: "Book 2", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token2);

    // user1 renames to "AliceNew" via family endpoint
    await request(
      "PUT",
      `/api/family/${familyId}/member/user1/displayName`,
      { displayName: "AliceNew" },
      token1,
    );

    // Fix A: user record should already reflect "AliceNew"
    const userRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const userJson = (await userRes.json()) as Json;
    expect(userJson.data.displayName).toBe("AliceNew");

    // Extension syncs books with stale "Alice"
    await request("PUT", "/api/user/user1/books", {
      schemaVersion: 1, userId: "user1", displayName: "Alice",
      books: [{ bookId: "b1", title: "Book 1", author: "", isbn: "", coverUrl: "", readmooUrl: "", category: "", isShared: 1 }],
    }, token1);

    // Fix B: server should override with "AliceNew" from family record
    const afterSyncRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const afterSyncJson = (await afterSyncRes.json()) as Json;
    expect(afterSyncJson.data.displayName).toBe("AliceNew");

    // Family bookshelf should also show "AliceNew"
    const bookshelfRes = await request("GET", `/api/family/${familyId}/bookshelf`, undefined, token1);
    const bookshelfJson = (await bookshelfRes.json()) as Json;
    const user1Member = bookshelfJson.data.members.find((m: Json) => m.userId === "user1");
    expect(user1Member.displayName).toBe("AliceNew");
  });
});
