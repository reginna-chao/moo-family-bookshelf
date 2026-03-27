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

function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
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
  return json.data as {
    familyId: string;
    ownerId: string;
    members: string[];
    maxMembers: number;
  };
}

async function createFamilyWithTwoMembers() {
  const family = await createFamily("user1");
  await request("POST", `/api/family/${family.familyId}/join`, {
    userId: "user2",
  });
  return family.familyId;
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
  });

  it("should reject create without userId", async () => {
    const res = await request("POST", "/api/family", {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_USER_ID");
  });

  it("should allow joining a family and return updated record", async () => {
    const family = await createFamily("user1");

    const joinRes = await request(
      "POST",
      `/api/family/${family.familyId}/join`,
      { userId: "user2" },
    );
    expect(joinRes.status).toBe(200);
    const joinJson = (await joinRes.json()) as Json;
    // Mutation returns updated FamilyRecord
    expect(joinJson.data.familyId).toBe(family.familyId);
    expect(joinJson.data.members).toEqual(["user1", "user2"]);
    expect(joinJson.data.ownerId).toBe("user1");

    // Verify via GET /members
    const membersRes = await request(
      "GET",
      `/api/family/${family.familyId}/members`,
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
    const family = await createFamily("user1");

    await request("POST", `/api/family/${family.familyId}/join`, {
      userId: "user1",
    });

    const membersRes = await request(
      "GET",
      `/api/family/${family.familyId}/members`,
    );
    const members = ((await membersRes.json()) as Json).data;
    expect(members.members).toEqual(["user1"]);
  });

  it("should allow leaving a family and return updated record", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2?userId=user2`,
    );
    expect(leaveRes.status).toBe(200);
    const leaveJson = (await leaveRes.json()) as Json;
    // Mutation returns updated FamilyRecord
    expect(leaveJson.data.members).toEqual(["user1"]);

    // Verify via GET /members
    const membersRes = await request("GET", `/api/family/${familyId}/members`);
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
    const family = await createFamily("user1");

    const joinRes = await request(
      "POST",
      `/api/family/${family.familyId}/join`,
      { userId: "user2" },
    );
    expect(joinRes.status).toBe(200);
  });

  it("should reject third member with FAMILY_FULL (409) when maxMembers is 2", async () => {
    const familyId = await createFamilyWithTwoMembers();

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
    const familyId = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2?userId=user1`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual(["user1"]);

    const membersRes = await request("GET", `/api/family/${familyId}/members`);
    const members = ((await membersRes.json()) as Json).data.members;
    expect(members).toEqual(["user1"]);
  });

  it("should reject owner trying to remove self with OWNER_CANNOT_LEAVE", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user1?userId=user1`,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("OWNER_CANNOT_LEAVE");
  });

  it("should allow non-owner to remove self (leave) and return updated record", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2?userId=user2`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual(["user1"]);

    const membersRes = await request("GET", `/api/family/${familyId}/members`);
    const members = ((await membersRes.json()) as Json).data.members;
    expect(members).toEqual(["user1"]);
  });

  it("should reject non-owner trying to remove other member with NOT_OWNER", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user1?userId=user2`,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_OWNER");
  });

  it("should return 400 MISSING_USER_ID when userId query param is absent", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_USER_ID");
  });

  it("should return 404 MEMBER_NOT_FOUND when target is not in the family", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user999?userId=user1`,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("should return 403 NOT_OWNER when random non-member tries to delete", async () => {
    const familyId = await createFamilyWithTwoMembers();

    // user999 is not in family at all, not owner → NOT_OWNER
    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2?userId=user999`,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_OWNER");
  });
});

// ===========================================================================
// PUT /api/family/:id/transfer
// ===========================================================================

describe("PUT /api/family/:id/transfer", () => {
  it("should transfer ownership and return updated record", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request("PUT", `/api/family/${familyId}/transfer`, {
      userId: "user1",
      newOwnerId: "user2",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ownerId).toBe("user2");
    expect(json.data.members).toEqual(["user1", "user2"]);

    // Verify via GET /members
    const membersRes = await request("GET", `/api/family/${familyId}/members`);
    const data = ((await membersRes.json()) as Json).data;
    expect(data.ownerId).toBe("user2");
  });

  it("should reject transfer by non-owner with NOT_OWNER", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request("PUT", `/api/family/${familyId}/transfer`, {
      userId: "user2",
      newOwnerId: "user2",
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_OWNER");
  });

  it("should reject transfer to non-member with INVALID_MEMBER", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request("PUT", `/api/family/${familyId}/transfer`, {
      userId: "user1",
      newOwnerId: "user999",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_MEMBER");
  });

  it("should reject transfer to self with SAME_OWNER", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res = await request("PUT", `/api/family/${familyId}/transfer`, {
      userId: "user1",
      newOwnerId: "user1",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("SAME_OWNER");
  });

  it("should return 400 when required fields are missing", async () => {
    const familyId = await createFamilyWithTwoMembers();

    const res1 = await request("PUT", `/api/family/${familyId}/transfer`, {
      userId: "user1",
    });
    expect(res1.status).toBe(400);

    const res2 = await request("PUT", `/api/family/${familyId}/transfer`, {
      newOwnerId: "user2",
    });
    expect(res2.status).toBe(400);

    const res3 = await request("PUT", `/api/family/${familyId}/transfer`, {});
    expect(res3.status).toBe(400);
  });

  it("should return 404 for non-existent family", async () => {
    const res = await request("PUT", "/api/family/aaaa-zzzz/transfer", {
      userId: "user1",
      newOwnerId: "user2",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should allow old owner to leave after transferring ownership", async () => {
    const familyId = await createFamilyWithTwoMembers();

    // Transfer ownership from user1 → user2
    const transferRes = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: "user1", newOwnerId: "user2" },
    );
    expect(transferRes.status).toBe(200);

    // Old owner (user1) leaves — now a non-owner, should succeed
    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/user1?userId=user1`,
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
    const family = await createFamily("user1");

    const membersRes = await request(
      "GET",
      `/api/family/${family.familyId}/members`,
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

    const res = await request("GET", "/api/family/abcd-ef01/members");
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Json).data;
    // ownerId defaults to first member
    expect(data.ownerId).toBe("alice");
    // maxMembers defaults to 2
    expect(data.maxMembers).toBe(2);
    expect(data.members).toEqual(["alice", "bob"]);
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
    const res = await request("GET", "/api/user/user1/books");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toBeNull();
  });

  it("should save and retrieve encrypted books, returning updated record", async () => {
    const payload = "encrypted-data-here";

    const putRes = await request("PUT", "/api/user/user1/books", { payload });
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as Json;
    // Mutation returns the UserBooksRecord
    expect(putJson.data.payload).toBe(payload);
    expect(putJson.data.lastUpdated).toBeDefined();

    const getRes = await request("GET", "/api/user/user1/books");
    const json = (await getRes.json()) as Json;
    expect(json.data.payload).toBe(payload);
    expect(json.data.lastUpdated).toBeDefined();
  });

  it("should reject empty payload", async () => {
    const res = await request("PUT", "/api/user/user1/books", { payload: "" });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Family Bookshelf Aggregation
// ===========================================================================

describe("Family Bookshelf Aggregation", () => {
  it("should aggregate books from all family members", async () => {
    const familyId = await createFamilyWithTwoMembers();

    // Both members save books
    await request("PUT", "/api/user/user1/books", {
      payload: "user1-encrypted",
    });
    await request("PUT", "/api/user/user2/books", {
      payload: "user2-encrypted",
    });

    // Get family bookshelf
    const res = await request("GET", `/api/family/${familyId}/bookshelf`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toHaveLength(2);
    expect(json.data.members[0].payload).toBe("user1-encrypted");
    expect(json.data.members[1].payload).toBe("user2-encrypted");
  });

  it("should return 404 for non-existent family bookshelf", async () => {
    const res = await request("GET", "/api/family/aaaa-zzzz/bookshelf");
    expect(res.status).toBe(404);
  });

  it("should not include former member after leave", async () => {
    const familyId = await createFamilyWithTwoMembers();

    await request("PUT", "/api/user/user2/books", {
      payload: "user2-data",
    });

    // user2 leaves
    await request(
      "DELETE",
      `/api/family/${familyId}/member/user2?userId=user2`,
    );

    // Bookshelf should only have user1
    const res = await request("GET", `/api/family/${familyId}/bookshelf`);
    const json = (await res.json()) as Json;
    expect(json.data.members).toHaveLength(1);
    expect(json.data.members[0].userId).toBe("user1");
  });
});
