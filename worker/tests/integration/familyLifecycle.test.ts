import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// ---------------------------------------------------------------------------
// Shared helpers (DRY — Finding #14)
// ---------------------------------------------------------------------------

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = {
    method,
    headers,
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv });
}

/** Shortcut to send a request with a raw string body (for invalid JSON tests). */
function rawRequest(method: string, path: string, rawBody: string) {
  return app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    },
    { KV: kv },
  );
}

async function createFamily(userId = "user1") {
  const res = await request("POST", "/api/family", { userId });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    ownerId: json.data.ownerId as string,
    members: json.data.members as string[],
    maxMembers: json.data.maxMembers as number,
    authToken: json.data.authToken as string,
  };
}

async function createFamilyWithTwoMembers() {
  const { familyId, authToken: token1 } = await createFamily("user1");
  const joinRes = await request("POST", `/api/family/${familyId}/join`, {
    userId: "user2",
  });
  const joinJson = (await joinRes.json()) as Json;
  const token2 = joinJson.data.authToken as string;
  return { familyId, token1, token2 };
}

// ---------------------------------------------------------------------------
// Reset KV before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Family Lifecycle
// ===========================================================================

describe("Family Lifecycle", () => {
  it("should create a family", async () => {
    const res = await request("POST", "/api/family", { userId: "user1" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.familyId).toBeDefined();
    expect(json.data.ownerId).toBe("user1");
    expect(json.data.members).toEqual(["user1"]);
    expect(json.data.maxMembers).toBe(2);
    expect(json.data.authToken).toBeDefined();
  });

  it("should reject create without userId", async () => {
    const res = await request("POST", "/api/family", {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_USER_ID");
  });

  it("should allow joining a family and return updated record", async () => {
    const { familyId, authToken: token1 } = await createFamily("user1");

    const joinRes = await request(
      "POST",
      `/api/family/${familyId}/join`,
      { userId: "user2" },
    );
    expect(joinRes.status).toBe(200);
    const joinJson = (await joinRes.json()) as Json;
    // Mutation returns updated FamilyRecord
    expect(joinJson.data.familyId).toBe(familyId);
    expect(joinJson.data.members).toEqual(["user1", "user2"]);
    expect(joinJson.data.ownerId).toBe("user1");
    expect(joinJson.data.authToken).toBeDefined();

    // Verify via GET /members (requires auth)
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data;
    expect(members.members).toEqual(["user1", "user2"]);
  });

  it("should return 404 for joining non-existent family", async () => {
    const res = await request("POST", "/api/family/aaaa-zzzz/join", {
      userId: "user1",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should not duplicate member on re-join", async () => {
    const { familyId } = await createFamily("user1");

    // Re-joining returns a new auth token (old one is invalidated)
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
    });
    const rejoinJson = (await rejoinRes.json()) as Json;
    const newToken = rejoinJson.data.authToken as string;

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      newToken,
    );
    const members = ((await membersRes.json()) as Json).data;
    expect(members.members).toEqual(["user1"]);
  });

  it("should allow leaving a family and return updated record", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
      undefined,
      token2,
    );
    expect(leaveRes.status).toBe(200);
    const leaveJson = (await leaveRes.json()) as Json;
    // Mutation returns updated FamilyRecord
    expect(leaveJson.data.members).toEqual(["user1"]);

    // Verify via GET /members
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data;
    expect(members.members).toEqual(["user1"]);
  });
});

// ===========================================================================
// Family creation response fields
// ===========================================================================

describe("Family creation response fields", () => {
  it("should include ownerId matching the creator", async () => {
    const res = await request("POST", "/api/family", { userId: "user1" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.ownerId).toBe("user1");
  });

  it("should include maxMembers defaulting to 2", async () => {
    const res = await request("POST", "/api/family", { userId: "user1" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.maxMembers).toBe(2);
  });
});

// ===========================================================================
// Family member limit
// ===========================================================================

describe("Family member limit", () => {
  it("should allow joining when under maxMembers", async () => {
    const { familyId } = await createFamily("user1");

    const joinRes = await request(
      "POST",
      `/api/family/${familyId}/join`,
      { userId: "user2" },
    );
    expect(joinRes.status).toBe(200);
  });

  it("should reject third member with FAMILY_FULL (409) when maxMembers is 2", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user3",
    });
    expect(joinRes.status).toBe(409);
    const json = (await joinRes.json()) as Json;
    expect(json.error.code).toBe("FAMILY_FULL");
  });
});

// ===========================================================================
// DELETE /api/family/:id/member/:uid
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid", () => {
  it("should allow owner to remove other member and return updated record", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
      undefined,
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual(["user1"]);

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data.members;
    expect(members).toEqual(["user1"]);
  });

  it("should reject owner trying to remove self with OWNER_CANNOT_LEAVE", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user1`,
      undefined,
      token1,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("OWNER_CANNOT_LEAVE");
  });

  it("should allow non-owner to remove self (leave) and return updated record", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
      undefined,
      token2,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual(["user1"]);

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data.members;
    expect(members).toEqual(["user1"]);
  });

  it("should reject non-owner trying to remove other member with NOT_OWNER", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user1`,
      undefined,
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_OWNER");
  });

  it("should return 401 when no auth token is provided", async () => {
    const { familyId } = await createFamily("user1");

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
    );
    expect(res.status).toBe(401);
  });

  it("should return 404 MEMBER_NOT_FOUND when target is not in the family", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user999`,
      undefined,
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("should return 401 for unauthenticated DELETE attempt", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    // No auth token provided → 401
    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// PUT /api/family/:id/transfer
// ===========================================================================

describe("PUT /api/family/:id/transfer", () => {
  it("should transfer ownership and return updated record", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: "user1", newOwnerId: "user2" },
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ownerId).toBe("user2");
    expect(json.data.members).toEqual(["user1", "user2"]);

    // Verify via GET /members
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const data = ((await membersRes.json()) as Json).data;
    expect(data.ownerId).toBe("user2");
  });

  it("should reject transfer by non-owner with NOT_OWNER", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: "user2", newOwnerId: "user2" },
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_OWNER");
  });

  it("should reject transfer to non-member with INVALID_MEMBER", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: "user1", newOwnerId: "user999" },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_MEMBER");
  });

  it("should reject transfer to self with SAME_OWNER", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: "user1", newOwnerId: "user1" },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("SAME_OWNER");
  });

  it("should return 400 when required fields are missing", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    // Only userId, no newOwnerId → 400
    const res1 = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: "user1" },
      token1,
    );
    expect(res1.status).toBe(400);

    // Empty body → 400
    const res2 = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      {},
      token1,
    );
    expect(res2.status).toBe(400);
  });

  it("should return 404 for non-existent family", async () => {
    // Need a valid token to pass auth middleware
    const { authToken: token1 } = await createFamily("user1");

    const res = await request(
      "PUT",
      "/api/family/aaaa-zzzz/transfer",
      { userId: "user1", newOwnerId: "user2" },
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should allow old owner to leave after transferring ownership", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Transfer ownership from user1 → user2
    const transferRes = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: "user1", newOwnerId: "user2" },
      token1,
    );
    expect(transferRes.status).toBe(200);

    // Old owner (user1) leaves — now a non-owner, should succeed
    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/user1`,
      undefined,
      token1,
    );
    expect(leaveRes.status).toBe(200);
    const leaveJson = (await leaveRes.json()) as Json;
    expect(leaveJson.data.members).toEqual(["user2"]);
    expect(leaveJson.data.ownerId).toBe("user2");
  });
});

// ===========================================================================
// GET /api/family/:id/members response
// ===========================================================================

describe("GET /api/family/:id/members response", () => {
  it("should include ownerId in the response", async () => {
    const { familyId, authToken: token1 } = await createFamily("user1");

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    expect(membersRes.status).toBe(200);
    const data = ((await membersRes.json()) as Json).data;
    expect(data.ownerId).toBe("user1");
  });

  it("should normalize legacy record without ownerId/maxMembers", async () => {
    // Manually insert a legacy record that lacks ownerId and maxMembers
    const legacyRecord = {
      familyId: "abcd-ef01",
      members: ["alice", "bob"],
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    await kv.put(kvKeys.family("abcd-ef01"), JSON.stringify(legacyRecord));
    // Insert member reverse lookup so auth membership check passes
    await kv.put(kvKeys.member("alice"), "abcd-ef01");

    // Generate a token for alice to authenticate
    const { generateAuthToken } = await import("../../src/middleware/auth");
    const aliceToken = await generateAuthToken(kv, "alice");

    const res = await request(
      "GET",
      "/api/family/abcd-ef01/members",
      undefined,
      aliceToken,
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Json).data;
    // ownerId defaults to first member
    expect(data.ownerId).toBe("alice");
    // maxMembers defaults to 2
    expect(data.maxMembers).toBe(2);
    expect(data.members).toEqual(["alice", "bob"]);
  });

  it("should return 401 for unauthenticated GET /api/family/:id/members", async () => {
    const { familyId } = await createFamily();
    const res = await request("GET", `/api/family/${familyId}/members`);
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Join edge cases
// ===========================================================================

describe("Join edge cases", () => {
  it("should return 409 ALREADY_IN_FAMILY when user belongs to another family", async () => {
    // Create two families
    const familyA = await createFamily("user1");
    const familyB = await createFamily("user3");

    // user2 joins family A
    await request("POST", `/api/family/${familyA.familyId}/join`, {
      userId: "user2",
    });

    // user2 tries to join family B → should be rejected
    const res = await request(
      "POST",
      `/api/family/${familyB.familyId}/join`,
      { userId: "user2" },
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("ALREADY_IN_FAMILY");
  });
});

// ===========================================================================
// Input validation
// ===========================================================================

describe("Input validation", () => {
  it("should return INVALID_JSON for malformed request body", async () => {
    const res = await rawRequest("POST", "/api/family", "{not valid json!!}");
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 400 INVALID_USER_ID for userId with special characters", async () => {
    const res = await request("POST", "/api/family", {
      userId: "user<script>",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });
});

// ===========================================================================
// Personal Books
// ===========================================================================

describe("Personal Books", () => {
  it("should return null for user with no books", async () => {
    // Need an auth token to access protected endpoint
    const { authToken: token1 } = await createFamily("user1");

    const res = await request("GET", "/api/user/user1/books", undefined, token1);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toBeNull();
  });

  it("should save and retrieve encrypted books, returning updated record", async () => {
    const { authToken: token1 } = await createFamily("user1");
    const payload = "encrypted-data-here";

    const putRes = await request(
      "PUT",
      "/api/user/user1/books",
      { payload },
      token1,
    );
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as Json;
    // Mutation returns the UserBooksRecord
    expect(putJson.data.payload).toBe(payload);
    expect(putJson.data.lastUpdated).toBeDefined();

    const getRes = await request("GET", "/api/user/user1/books", undefined, token1);
    const json = (await getRes.json()) as Json;
    expect(json.data.payload).toBe(payload);
    expect(json.data.lastUpdated).toBeDefined();
  });

  it("should reject empty payload", async () => {
    const { authToken: token1 } = await createFamily("user1");

    const res = await request(
      "PUT",
      "/api/user/user1/books",
      { payload: "" },
      token1,
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Family Bookshelf Aggregation
// ===========================================================================

describe("Family Bookshelf Aggregation", () => {
  it("should aggregate books from all family members", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Both members save books (each with their own token)
    await request("PUT", "/api/user/user1/books", {
      payload: "user1-encrypted",
    }, token1);
    await request("PUT", "/api/user/user2/books", {
      payload: "user2-encrypted",
    }, token2);

    // Get family bookshelf
    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toHaveLength(2);
    expect(json.data.members[0].payload).toBe("user1-encrypted");
    expect(json.data.members[1].payload).toBe("user2-encrypted");
  });

  it("should return 403 for authenticated user accessing another family's bookshelf", async () => {
    // user1 is in their own family, so accessing a different family returns 403
    const { authToken: token1 } = await createFamily("user1");

    const res = await request(
      "GET",
      "/api/family/aaaa-zzzz/bookshelf",
      undefined,
      token1,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 401 for unauthenticated bookshelf request", async () => {
    const { familyId } = await createFamily("user1");

    const res = await request("GET", `/api/family/${familyId}/bookshelf`);
    expect(res.status).toBe(401);
  });

  it("should not include former member after leave", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    await request("PUT", "/api/user/user2/books", {
      payload: "user2-data",
    }, token2);

    // user2 leaves
    await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
      undefined,
      token2,
    );

    // Bookshelf should only have user1
    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token1,
    );
    const json = (await res.json()) as Json;
    expect(json.data.members).toHaveLength(1);
    expect(json.data.members[0].userId).toBe("user1");
  });
});
