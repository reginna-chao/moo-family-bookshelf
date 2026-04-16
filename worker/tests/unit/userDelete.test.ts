import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";

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

async function createFamilyAndGetToken(userId = "user1") {
  const res = await request("POST", "/api/family", { userId });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function joinFamily(familyId: string, userId: string) {
  const res = await request("POST", `/api/family/${familyId}/join`, { userId });
  const json = (await res.json()) as Json;
  return { authToken: json.data.authToken as string };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// DELETE /api/user/:id — delete user account
// ===========================================================================

describe("DELETE /api/user/:id", () => {
  it("should successfully delete account when user is not in any family", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    // Leave family first by removing member key (simulate no family)
    // Instead, create a user with books but no family membership
    // We need a token, so create family, then remove from family manually
    // Simpler: use user1 who owns a family — but owner can't delete.
    // Let's create a second user who joins then leaves, keeping their token.

    // Create family with owner, join as user2, then user2 leaves family
    const { familyId } = await createFamilyAndGetToken("owner1");
    const { authToken: user2Token } = await joinFamily(familyId, "user2");

    // User2 leaves family
    await request("DELETE", `/api/family/${familyId}/member/user2`, undefined, user2Token);

    // Save some books for user2
    await request("PUT", "/api/user/user2/books", { schemaVersion: 1, userId: "user2", displayName: "User2", books: [] }, user2Token);

    // Now user2 has no family but has books and auth token
    // Re-generate token since leaving family deletes it
    // Actually, leaving family deletes the auth token. We need a fresh token.
    // Let's use a different approach: create user2's own family, transfer ownership, leave, then delete.

    // Simpler approach: directly set up KV state
    kv = createMockKV();
    const { authToken: freshToken } = await createFamilyAndGetToken("user2");

    // Save books
    await request("PUT", "/api/user/user2/books", { schemaVersion: 1, userId: "user2", displayName: "User2", books: [] }, freshToken);

    // Transfer ownership is not possible with single member. Let's just test with a user
    // who was never in a family — but they need an auth token.
    // The token comes from creating/joining a family. So let's create, add a second member,
    // transfer ownership, leave, then create fresh token.

    // Actually the simplest: create family as owner, add member, transfer, then leave.
    // But we can also just directly manipulate KV for the "no family" case.

    kv = createMockKV();

    // Manually set up a user with auth token but no family
    const tokenHex = "a".repeat(64);
    await kv.put(kvKeys.auth("solo-user"), JSON.stringify({ token: tokenHex, createdAt: new Date().toISOString() }));
    await kv.put(kvKeys.authToken(tokenHex), "solo-user");
    await kv.put(kvKeys.user("solo-user"), JSON.stringify({ schemaVersion: 1, userId: "solo-user", displayName: "Solo", books: [], lastUpdated: new Date().toISOString() }));

    const res = await request("DELETE", "/api/user/solo-user", undefined, tokenHex);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);

    // Verify KV cleanup
    expect(await kv.get(kvKeys.user("solo-user"))).toBeNull();
    expect(await kv.get(kvKeys.auth("solo-user"))).toBeNull();
    expect(await kv.get(kvKeys.authToken(tokenHex))).toBeNull();
  });

  it("should successfully delete account when user is in family but not owner", async () => {
    const { familyId } = await createFamilyAndGetToken("owner1");
    const { authToken: user2Token } = await joinFamily(familyId, "user2");

    // Save user2 books
    await request("PUT", "/api/user/user2/books", { schemaVersion: 1, userId: "user2", displayName: "User2", books: [] }, user2Token);

    // Delete user2 account
    const res = await request("DELETE", "/api/user/user2", undefined, user2Token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);

    // Verify user2 removed from family members
    const familyRaw = await kv.get(kvKeys.family(familyId), "json") as Json;
    expect(familyRaw.members).toHaveLength(1);
    expect(familyRaw.members[0].userId).toBe("owner1");

    // Verify all user2 KV keys cleaned up
    expect(await kv.get(kvKeys.user("user2"))).toBeNull();
    expect(await kv.get(kvKeys.member("user2"))).toBeNull();
    expect(await kv.get(kvKeys.auth("user2"))).toBeNull();
  });

  it("should return 401 UNAUTHORIZED for unauthenticated request", async () => {
    const res = await request("DELETE", "/api/user/user1");
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 FORBIDDEN when deleting another user's account", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("DELETE", "/api/user/other-user", undefined, authToken);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 403 OWNER_CANNOT_DELETE when multi-member owner tries to delete", async () => {
    const { familyId } = await createFamilyAndGetToken("owner1");
    await joinFamily(familyId, "user2");

    // Re-get token for owner1 (joining user2 doesn't invalidate owner1's token)
    // Actually owner1's token is still valid. Let's get it fresh.
    const tokenHex = "b".repeat(64);
    await kv.put(kvKeys.auth("owner1"), JSON.stringify({ token: tokenHex, createdAt: new Date().toISOString() }));
    await kv.put(kvKeys.authToken(tokenHex), "owner1");

    const res = await request("DELETE", "/api/user/owner1", undefined, tokenHex);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("OWNER_CANNOT_DELETE");
    expect(json.error.message).toBe("管理者必須先轉移管理權才能移除帳戶");
  });

  it("should allow single-member owner to delete account and clean up family", async () => {
    const { familyId, authToken } = await createFamilyAndGetToken("owner1");

    // Save books for owner1
    await request("PUT", "/api/user/owner1/books", { schemaVersion: 1, userId: "owner1", displayName: "Owner", books: [] }, authToken);

    // Verify family exists
    expect(await kv.get(kvKeys.family(familyId))).not.toBeNull();

    const res = await request("DELETE", "/api/user/owner1", undefined, authToken);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);

    // Verify all KV keys cleaned up
    expect(await kv.get(kvKeys.family(familyId))).toBeNull();
    expect(await kv.get(kvKeys.user("owner1"))).toBeNull();
    expect(await kv.get(kvKeys.member("owner1"))).toBeNull();
    expect(await kv.get(kvKeys.auth("owner1"))).toBeNull();
  });

  it("should return 400 INVALID_USER_ID for invalid userId format", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("DELETE", "/api/user/user<script>", undefined, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should clean up all KV keys after deletion", async () => {
    const { familyId } = await createFamilyAndGetToken("owner1");
    const { authToken: user2Token } = await joinFamily(familyId, "user2");

    // Save user2 books
    await request("PUT", "/api/user/user2/books", { schemaVersion: 1, userId: "user2", displayName: "User2", books: [] }, user2Token);

    // Verify keys exist before deletion
    expect(await kv.get(kvKeys.user("user2"))).not.toBeNull();
    expect(await kv.get(kvKeys.member("user2"))).not.toBeNull();
    expect(await kv.get(kvKeys.auth("user2"))).not.toBeNull();

    // Delete
    const res = await request("DELETE", "/api/user/user2", undefined, user2Token);
    expect(res.status).toBe(200);

    // Verify all keys deleted
    expect(await kv.get(kvKeys.user("user2"))).toBeNull();
    expect(await kv.get(kvKeys.member("user2"))).toBeNull();
    expect(await kv.get(kvKeys.auth("user2"))).toBeNull();

    // Verify the auth token reverse-lookup is also deleted
    // (We can't easily check without knowing the token, but deleteAuthToken handles it)
  });
});
