import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";
import { ALICE, BOB, NOBODY, USER1, USER2, USER3 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// ---------------------------------------------------------------------------
// Shared helpers (DRY — Finding #14)
// ---------------------------------------------------------------------------

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
  const init: RequestInit = {
    method,
    headers,
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
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
    { KV: kv, DEV_MODE: "1" },
  );
}

async function createFamily(userId = USER1, displayName?: string) {
  const body: Record<string, string> = { userId };
  if (displayName !== undefined) body.displayName = displayName;
  const res = await request("POST", "/api/family", body);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    ownerId: json.data.ownerId as string,
    members: json.data.members as { userId: string; displayName: string }[],
    maxMembers: json.data.maxMembers as number,
    authToken: json.data.authToken as string,
  };
}

async function createFamilyWithTwoMembers() {
  const { familyId, authToken: token1 } = await createFamily(USER1);
  const joinRes = await request("POST", `/api/family/${familyId}/join`, {
    userId: USER2,
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
  it("should create a family with default empty displayName", async () => {
    const res = await request("POST", "/api/family", { userId: USER1 });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.familyId).toBeDefined();
    expect(json.data.ownerId).toBe(USER1);
    expect(json.data.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
    ]);
    expect(json.data.maxMembers).toBe(2);
    expect(json.data.authToken).toBeDefined();
  });

  it("should create a family with a custom displayName", async () => {
    const res = await request("POST", "/api/family", {
      userId: USER1,
      displayName: "Alice",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual([
      { userId: USER1, displayName: "Alice", canLend: 1 },
    ]);
  });

  it("should reject create without userId", async () => {
    const res = await request("POST", "/api/family", {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_USER_ID");
  });

  it("should allow joining a family and return updated record", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      displayName: "Bob",
    });
    expect(joinRes.status).toBe(200);
    const joinJson = (await joinRes.json()) as Json;
    // Mutation returns updated FamilyRecord
    expect(joinJson.data.familyId).toBe(familyId);
    expect(joinJson.data.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
      { userId: USER2, displayName: "Bob", canLend: 1 },
    ]);
    expect(joinJson.data.ownerId).toBe(USER1);
    expect(joinJson.data.authToken).toBeDefined();

    // Verify via GET /members (requires auth)
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data;
    expect(members.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
      { userId: USER2, displayName: "Bob", canLend: 1 },
    ]);
  });

  it("should return 404 for joining non-existent family", async () => {
    const res = await request("POST", "/api/family/aaaa-zzzz/join", {
      userId: USER1,
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should not duplicate member on re-join", async () => {
    const { familyId } = await createFamily(USER1);

    // Re-joining returns a new auth token (old one is invalidated)
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER1,
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
    expect(members.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
    ]);
  });

  it("should allow leaving a family and return updated record", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${USER2}`,
      undefined,
      token2,
    );
    expect(leaveRes.status).toBe(200);
    const leaveJson = (await leaveRes.json()) as Json;
    // Mutation returns updated FamilyRecord
    expect(leaveJson.data.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
    ]);

    // Verify via GET /members
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data;
    expect(members.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
    ]);
  });
});

// ===========================================================================
// Family creation response fields
// ===========================================================================

describe("Family creation response fields", () => {
  it("should include ownerId matching the creator", async () => {
    const res = await request("POST", "/api/family", { userId: USER1 });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.ownerId).toBe(USER1);
  });

  it("should include maxMembers defaulting to 2", async () => {
    const res = await request("POST", "/api/family", { userId: USER1 });
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
    const { familyId } = await createFamily(USER1);

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(joinRes.status).toBe(200);
  });

  it("should reject third member with FAMILY_FULL (409) when maxMembers is 2", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER3,
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
      `/api/family/${familyId}/member/${USER2}`,
      undefined,
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
    ]);

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data.members;
    expect(members).toEqual([{ userId: USER1, displayName: "", canLend: 1 }]);
  });

  it("should reject owner trying to remove self with OWNER_CANNOT_LEAVE", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/${USER1}`,
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
      `/api/family/${familyId}/member/${USER2}`,
      undefined,
      token2,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
    ]);

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const members = ((await membersRes.json()) as Json).data.members;
    expect(members).toEqual([{ userId: USER1, displayName: "", canLend: 1 }]);
  });

  it("should reject non-owner trying to remove other member with NOT_OWNER", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/${USER1}`,
      undefined,
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_OWNER");
  });

  it("should return 401 when no auth token is provided", async () => {
    const { familyId } = await createFamily(USER1);

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/${USER2}`,
    );
    expect(res.status).toBe(401);
  });

  it("should return 404 MEMBER_NOT_FOUND when target is not in the family", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/${NOBODY}`,
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
      `/api/family/${familyId}/member/${USER2}`,
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
      { userId: USER1, newOwnerId: USER2 },
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ownerId).toBe(USER2);
    expect(json.data.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
      { userId: USER2, displayName: "", canLend: 1 },
    ]);

    // Verify via GET /members
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const data = ((await membersRes.json()) as Json).data;
    expect(data.ownerId).toBe(USER2);
  });

  it("should reject transfer by non-owner with NOT_OWNER", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { userId: USER2, newOwnerId: USER2 },
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
      { userId: USER1, newOwnerId: NOBODY },
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
      { userId: USER1, newOwnerId: USER1 },
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
      { userId: USER1 },
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
    const { authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      "/api/family/aaaa-zzzz/transfer",
      { userId: USER1, newOwnerId: USER2 },
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
      { userId: USER1, newOwnerId: USER2 },
      token1,
    );
    expect(transferRes.status).toBe(200);

    // Old owner (user1) leaves — now a non-owner, should succeed
    const leaveRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${USER1}`,
      undefined,
      token1,
    );
    expect(leaveRes.status).toBe(200);
    const leaveJson = (await leaveRes.json()) as Json;
    expect(leaveJson.data.members).toEqual([
      { userId: USER2, displayName: "", canLend: 1 },
    ]);
    expect(leaveJson.data.ownerId).toBe(USER2);
  });
});

// ===========================================================================
// GET /api/family/:id/members response
// ===========================================================================

describe("GET /api/family/:id/members response", () => {
  it("should include ownerId in the response", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    expect(membersRes.status).toBe(200);
    const data = ((await membersRes.json()) as Json).data;
    expect(data.ownerId).toBe(USER1);
  });

  it("should return members as { userId, displayName }[]", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1, "Alice");

    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    expect(membersRes.status).toBe(200);
    const data = ((await membersRes.json()) as Json).data;
    expect(data.members).toEqual([
      { userId: USER1, displayName: "Alice", canLend: 1 },
    ]);
  });

  it("should normalize legacy record without ownerId/maxMembers", async () => {
    // Manually insert a legacy record that lacks ownerId and maxMembers
    const legacyRecord = {
      familyId: "abcd-ef01",
      members: [
        { userId: ALICE, displayName: "Alice" },
        { userId: BOB, displayName: "Bob" },
      ],
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    await kv.put(kvKeys.family("abcd-ef01"), JSON.stringify(legacyRecord));
    // Insert member reverse lookup so auth membership check passes
    await kv.put(kvKeys.member(ALICE), "abcd-ef01");

    // Generate a token for alice to authenticate
    const { generateAuthToken } = await import("../../src/middleware/auth");
    const aliceToken = await generateAuthToken(kv, ALICE);

    const res = await request(
      "GET",
      "/api/family/abcd-ef01/members",
      undefined,
      aliceToken,
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Json).data;
    // ownerId defaults to first member's userId
    expect(data.ownerId).toBe(ALICE);
    // maxMembers defaults to 2
    expect(data.maxMembers).toBe(2);
    expect(data.members).toEqual([
      { userId: ALICE, displayName: "Alice", canLend: 1 },
      { userId: BOB, displayName: "Bob", canLend: 1 },
    ]);
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
    const familyA = await createFamily(USER1);
    const familyB = await createFamily(USER3);

    // user2 joins family A
    await request("POST", `/api/family/${familyA.familyId}/join`, {
      userId: USER2,
    });

    // user2 tries to join family B → should be rejected
    const res = await request("POST", `/api/family/${familyB.familyId}/join`, {
      userId: USER2,
    });
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

  it("should reject displayName exceeding 20 characters on create", async () => {
    const res = await request("POST", "/api/family", {
      userId: USER1,
      displayName: "a".repeat(21),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_DISPLAY_NAME");
  });

  it("should reject displayName exceeding 20 characters on join", async () => {
    const { familyId } = await createFamily(USER1);
    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      displayName: "a".repeat(21),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_DISPLAY_NAME");
  });

  it("should trim whitespace from displayName", async () => {
    const res = await request("POST", "/api/family", {
      userId: USER1,
      displayName: "  Alice  ",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.members[0].displayName).toBe("Alice");
  });
});

// ===========================================================================
// Personal Books
// ===========================================================================

describe("Personal Books", () => {
  it("should return null for user with no books", async () => {
    // Need an auth token to access protected endpoint
    const { authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toBeNull();
  });

  it("should save and retrieve books, returning updated record", async () => {
    const { authToken: token1 } = await createFamily(USER1);
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

    const putRes = await request(
      "PUT",
      `/api/user/${USER1}/books`,
      personalBooks,
      token1,
    );
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as Json;
    // Mutation returns the UserBooksRecord
    expect(putJson.data.books).toHaveLength(1);
    expect(putJson.data.books[0].bookId).toBe("b1");
    expect(putJson.data.lastUpdated).toBeDefined();

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      token1,
    );
    const json = (await getRes.json()) as Json;
    expect(json.data.books).toHaveLength(1);
    expect(json.data.books[0].bookId).toBe("b1");
    expect(json.data.lastUpdated).toBeDefined();
  });

  it("should reject missing books array", async () => {
    const { authToken: token1 } = await createFamily(USER1);

    const res = await request("PUT", `/api/user/${USER1}/books`, {}, token1);
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
    await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        schemaVersion: 1,
        userId: USER1,
        displayName: "User1",
        books: [
          {
            bookId: "b1",
            title: "Book 1",
            author: "",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: 1,
          },
        ],
      },
      token1,
    );
    await request(
      "PUT",
      `/api/user/${USER2}/books`,
      {
        schemaVersion: 1,
        userId: USER2,
        displayName: "User2",
        books: [
          {
            bookId: "b2",
            title: "Book 2",
            author: "",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: 1,
          },
        ],
      },
      token2,
    );

    // Get family bookshelf (only shared books are returned)
    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toHaveLength(2);
    expect(json.data.members[0].books).toHaveLength(1);
    expect(json.data.members[0].books[0].bookId).toBe("b1");
    expect(json.data.members[1].books).toHaveLength(1);
    expect(json.data.members[1].books[0].bookId).toBe("b2");
  });

  it("should include displayName in bookshelf response", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1, "Alice");

    // Join with displayName
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      displayName: "Bob",
    });
    const token2 = ((await joinRes.json()) as Json).data.authToken;

    await request(
      "PUT",
      `/api/user/${USER1}/books`,
      {
        schemaVersion: 1,
        userId: USER1,
        displayName: "Alice",
        books: [
          {
            bookId: "b1",
            title: "Book 1",
            author: "",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: 1,
          },
        ],
      },
      token1,
    );
    await request(
      "PUT",
      `/api/user/${USER2}/books`,
      {
        schemaVersion: 1,
        userId: USER2,
        displayName: "Bob",
        books: [
          {
            bookId: "b2",
            title: "Book 2",
            author: "",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: 1,
          },
        ],
      },
      token2,
    );

    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token1,
    );
    const json = (await res.json()) as Json;
    expect(json.data.members[0].displayName).toBe("Alice");
    expect(json.data.members[1].displayName).toBe("Bob");
  });

  it("should return 404 (not 403) for an authenticated user accessing another family's bookshelf — info-hiding", async () => {
    // A non-member gets 404 NOT_FOUND, never 403. This is deliberate: returning
    // 403 would confirm the family exists, letting an outsider probe which family
    // ids are real. 404 keeps the family's very existence hidden from non-members.
    const { authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "GET",
      "/api/family/aaaa-zzzz/bookshelf",
      undefined,
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("should return 401 for unauthenticated bookshelf request", async () => {
    const { familyId } = await createFamily(USER1);

    const res = await request("GET", `/api/family/${familyId}/bookshelf`);
    expect(res.status).toBe(401);
  });

  it("should not include former member after leave", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    await request(
      "PUT",
      `/api/user/${USER2}/books`,
      {
        schemaVersion: 1,
        userId: USER2,
        displayName: "User2",
        books: [
          {
            bookId: "b2",
            title: "Book 2",
            author: "",
            isbn: "",
            coverUrl: "",
            readmooUrl: "",
            category: "",
            isShared: 0,
          },
        ],
      },
      token2,
    );

    // user2 leaves
    await request(
      "DELETE",
      `/api/family/${familyId}/member/${USER2}`,
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
    expect(json.data.members[0].userId).toBe(USER1);
  });
});

// ===========================================================================
// PUT /api/family/:id/member/:uid/displayName
// ===========================================================================

describe("PUT /api/family/:id/member/:uid/displayName", () => {
  it("should update own display name", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "Alice" },
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toEqual({ userId: USER1, displayName: "Alice" });

    // Verify via GET /members
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    const data = ((await membersRes.json()) as Json).data;
    expect(data.members[0].displayName).toBe("Alice");
  });

  it("should allow setting display name to empty string", async () => {
    const { familyId, authToken: token1 } = await createFamily(
      USER1,
      "OldName",
    );

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "" },
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.displayName).toBe("");
  });

  it("should trim whitespace from display name", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "  Alice  " },
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.displayName).toBe("Alice");
  });

  it("should reject display name exceeding 20 characters", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "a".repeat(21) },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_DISPLAY_NAME");
  });

  it("should allow display name of exactly 20 characters", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "a".repeat(20) },
      token1,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.displayName).toBe("a".repeat(20));
  });

  it("should reject missing displayName field", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      {},
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_DISPLAY_NAME");
  });

  it("should reject non-string displayName", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: 123 },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_DISPLAY_NAME");
  });

  it("should return 401 without auth token", async () => {
    const { familyId } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER1}/displayName`,
      { displayName: "Alice" },
    );
    expect(res.status).toBe(401);
  });

  it("should return 403 when trying to update another user's display name", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER2}/displayName`,
      { displayName: "Hacked" },
      token1,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 404 when user is not a member of the family", async () => {
    const { familyId } = await createFamily(USER1);
    // Create a separate family for user2 to get a valid token
    const { authToken: token2 } = await createFamily(USER2);

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/${USER2}/displayName`,
      { displayName: "Test" },
      token2,
    );
    // user2 != user2 would be caught as FORBIDDEN first since callerId != targetUserId
    // Actually user2 is trying to update user2 (self) but not in this family
    // Wait — callerId is user2, targetUserId is user2, so it passes the self-check
    // Then it loads the family and checks membership — user2 is NOT in familyId
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("should return 404 for non-existent family", async () => {
    const { authToken: token1 } = await createFamily(USER1);

    const res = await request(
      "PUT",
      `/api/family/aaaa-zzzz/member/${USER1}/displayName`,
      { displayName: "Test" },
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should return 400 for invalid JSON body", async () => {
    const { familyId, authToken: token1 } = await createFamily(USER1);

    const res = app.request(
      `/api/family/${familyId}/member/${USER1}/displayName`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: "{invalid json}",
      },
      { KV: kv, DEV_MODE: "1" },
    );
    expect((await res).status).toBe(400);
  });
});
