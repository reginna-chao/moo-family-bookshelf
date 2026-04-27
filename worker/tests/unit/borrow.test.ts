import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys, BorrowStatus, BoolFlag, type BorrowRequest, type FamilyRecord } from "../../src/kv/schema";
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

async function createFamilyAndGetToken(userId = "user1") {
  const res = await request("POST", "/api/family", { userId, displayName: "User1" });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function joinFamilyAndGetToken(familyId: string, userId: string, displayName = "") {
  const res = await request("POST", `/api/family/${familyId}/join`, {
    userId,
    displayName,
  });
  const json = (await res.json()) as Json;
  return {
    authToken: json.data.authToken as string,
  };
}

async function createFamilyWithTwoMembers() {
  const { familyId, authToken: token1 } = await createFamilyAndGetToken("user1");
  const { authToken: token2 } = await joinFamilyAndGetToken(familyId, "user2", "User2");
  return { familyId, token1, token2 };
}

const validBorrowBody = {
  bookId: "book-123",
  bookTitle: "Test Book",
  bookAuthor: "Test Author",
  bookCoverUrl: "https://example.com/cover.jpg",
  ownerId: "user1",
};

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// POST /api/family/:id/borrow — create borrow request
// ===========================================================================

describe("POST /api/family/:id/borrow", () => {
  it("should return 201 with correct response shape", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body = {
      bookId: "book-123",
      bookTitle: "Test Book",
      bookAuthor: "Test Author",
      bookCoverUrl: "https://example.com/cover.jpg",
      ownerId: "user1",
    };

    const res = await request("POST", `/api/family/${familyId}/borrow`, body, token2);
    expect(res.status).toBe(201);

    const json = (await res.json()) as Json;
    const data = json.data;
    expect(data.requestId).toBeDefined();
    expect(data.familyId).toBe(familyId);
    expect(data.borrowerId).toBe("user2");
    expect(data.borrowerName).toBe("User2");
    expect(data.ownerId).toBe("user1");
    expect(data.bookId).toBe("book-123");
    expect(data.bookTitle).toBe("Test Book");
    expect(data.bookAuthor).toBe("Test Author");
    expect(data.bookCoverUrl).toBe("https://example.com/cover.jpg");
    expect(data.status).toBe(BorrowStatus.PENDING);
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return 401 if not authenticated", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const res = await request("POST", `/api/family/${familyId}/borrow`, validBorrowBody);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 if missing required fields (bookId)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookTitle: "T", bookAuthor: "A", bookCoverUrl: "U", ownerId: "user1" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if missing required fields (bookTitle)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookId: "b1", bookAuthor: "A", bookCoverUrl: "U", ownerId: "user1" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if missing required fields (bookAuthor)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookId: "b1", bookTitle: "T", bookCoverUrl: "U", ownerId: "user1" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if missing required fields (bookCoverUrl)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookId: "b1", bookTitle: "T", bookAuthor: "A", ownerId: "user1" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if missing required fields (ownerId)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { bookId: "b1", bookTitle: "T", bookAuthor: "A", bookCoverUrl: "U" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 400 if ownerId format is invalid", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user<script>" },
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 404 if family not found", async () => {
    const { token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      "/api/family/zzzz-zzzz/borrow",
      validBorrowBody,
      token2,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should return 403 NOT_FAMILY_MEMBER if caller is not in the family", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    // Create user3 with their own family, then try to borrow from familyId
    const { authToken: token3 } = await createFamilyAndGetToken("user3");

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      validBorrowBody,
      token3,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FAMILY_MEMBER");
  });

  it("should return 403 INVALID_OWNER if ownerId is the same as caller (can't borrow own book)", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user1" },
      token1, // user1 trying to borrow from user1
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_OWNER");
  });

  it("should return 403 INVALID_OWNER if ownerId is not a family member", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user999" },
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_OWNER");
  });

  it("should return 403 LENDING_DISABLED if owner has canLend = FALSE", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Owner (user1) disables lending for user1
    await request(
      "PATCH",
      `/api/family/${familyId}/member/user1`,
      { canLend: BoolFlag.FALSE },
      token1,
    );

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user1" },
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("LENDING_DISABLED");
  });

  it("should return 403 LENDING_DISABLED if borrower has canLend = FALSE", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Owner (user1) disables lending for user2 (borrower)
    await request(
      "PATCH",
      `/api/family/${familyId}/member/user2`,
      { canLend: BoolFlag.FALSE },
      token1,
    );

    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user1" },
      token2,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("LENDING_DISABLED");
  });

  it("should return 400 DUPLICATE_REQUEST if PENDING request exists for same borrower + bookId", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body = { ...validBorrowBody, ownerId: "user1" };

    // First request should succeed
    const res1 = await request("POST", `/api/family/${familyId}/borrow`, body, token2);
    expect(res1.status).toBe(201);

    // Second identical request should fail
    const res2 = await request("POST", `/api/family/${familyId}/borrow`, body, token2);
    expect(res2.status).toBe(400);
    const json = (await res2.json()) as Json;
    expect(json.error.code).toBe("DUPLICATE_REQUEST");
  });

  it("should allow duplicate request for different bookId", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body1 = { ...validBorrowBody, ownerId: "user1", bookId: "book-1" };
    const body2 = { ...validBorrowBody, ownerId: "user1", bookId: "book-2" };

    const res1 = await request("POST", `/api/family/${familyId}/borrow`, body1, token2);
    expect(res1.status).toBe(201);

    const res2 = await request("POST", `/api/family/${familyId}/borrow`, body2, token2);
    expect(res2.status).toBe(201);
  });

  it("should store borrow request in KV", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const body = { ...validBorrowBody, ownerId: "user1" };
    const res = await request("POST", `/api/family/${familyId}/borrow`, body, token2);
    expect(res.status).toBe(201);

    const json = (await res.json()) as Json;
    const requestId = json.data.requestId;

    // Verify KV storage
    const stored = await kv.get(kvKeys.borrow(requestId), "json") as BorrowRequest;
    expect(stored).not.toBeNull();
    expect(stored.requestId).toBe(requestId);
    expect(stored.status).toBe(BorrowStatus.PENDING);

    // Verify index
    const index = await kv.get(kvKeys.borrowsByFamily(familyId), "json") as string[];
    expect(index).toContain(requestId);
  });

  it("should return 400 for invalid JSON body", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();

    const res = app.request(
      `/api/family/${familyId}/borrow`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token2}`,
        },
        body: "{invalid json}",
      },
      { KV: kv, DEV_MODE: "1" },
    );
    expect((await res).status).toBe(400);
  });

  it("should return 400 for invalid family ID format", async () => {
    const { token2 } = await createFamilyWithTwoMembers();

    const res = await request(
      "POST",
      "/api/family/INVALID/borrow",
      validBorrowBody,
      token2,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });
});

// ===========================================================================
// GET /api/family/:id/borrow — list borrow requests
// ===========================================================================

describe("GET /api/family/:id/borrow", () => {
  it("should return all borrow requests for the family", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();

    // Create two borrow requests
    await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user1", bookId: "book-1" },
      token2,
    );
    await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user1", bookId: "book-2" },
      token2,
    );

    const res = await request("GET", `/api/family/${familyId}/borrow`, undefined, token1);
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data).toHaveLength(2);
    expect(json.data[0].bookId).toBe("book-1");
    expect(json.data[1].bookId).toBe("book-2");
  });

  it("should return empty array when no requests exist", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request("GET", `/api/family/${familyId}/borrow`, undefined, token1);
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data).toEqual([]);
  });

  it("should return 401 if not authenticated", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const res = await request("GET", `/api/family/${familyId}/borrow`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 if caller is not a family member", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    // user3 is not in the family
    const { authToken: token3 } = await createFamilyAndGetToken("user3");

    const res = await request("GET", `/api/family/${familyId}/borrow`, undefined, token3);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FAMILY_MEMBER");
  });

  it("should return 404 if family not found", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request("GET", "/api/family/zzzz-zzzz/borrow", undefined, token1);
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should return 400 for invalid family ID format", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request("GET", "/api/family/INVALID/borrow", undefined, token1);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });
});

// ===========================================================================
// PATCH /api/borrow/:requestId — update borrow status
// ===========================================================================

describe("PATCH /api/borrow/:requestId", () => {
  /** Helper: create a PENDING borrow request and return its requestId. */
  async function createPendingBorrowRequest(familyId: string, token2: string) {
    const res = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      { ...validBorrowBody, ownerId: "user1" },
      token2,
    );
    const json = (await res.json()) as Json;
    return json.data.requestId as string;
  }

  // --- Valid transitions ---

  it("should allow PENDING -> LENT (by owner)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.LENT);
    expect(json.data.updatedAt).toBeDefined();
  });

  it("should allow PENDING -> REJECTED (by owner)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.REJECTED },
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.REJECTED);
  });

  it("should allow PENDING -> CANCELLED (by borrower)", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token2,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.CANCELLED);
  });

  it("should allow LENT -> RETURNED (by owner)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // First transition to LENT
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    // Then mark as RETURNED
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token1,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.RETURNED);
  });

  it("should allow LENT -> RETURNED (by borrower)", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // First transition to LENT
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    // Borrower marks as RETURNED
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token2,
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.data.status).toBe(BorrowStatus.RETURNED);
  });

  // --- Invalid transitions ---

  it("should return 422 for PENDING -> RETURNED", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for LENT -> CANCELLED", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Transition to LENT
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    // Try invalid: LENT -> CANCELLED
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token2,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for REJECTED -> any transition", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Transition to REJECTED (terminal)
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.REJECTED },
      token1,
    );

    // Try REJECTED -> LENT
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for RETURNED -> any transition", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // PENDING -> LENT -> RETURNED (terminal)
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token1,
    );

    // Try RETURNED -> LENT
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("should return 422 for CANCELLED -> any transition", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Cancel
    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token2,
    );

    // Try CANCELLED -> PENDING (or any)
    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token2,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  // --- Permission checks ---

  it("should return 403 if borrower tries to LENT", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token2, // borrower
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 403 if borrower tries to REJECTED", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.REJECTED },
      token2, // borrower
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 403 if owner tries to CANCELLED", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token1, // owner
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 403 if unrelated user tries any transition", async () => {
    const { familyId, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    // Create user3 with their own token
    const { authToken: token3 } = await createFamilyAndGetToken("user3");

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token3,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  // --- Other error cases ---

  it("should return 404 if requestId not found", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    // Well-formed UUID v4 that doesn't exist in KV
    const validButMissingId = crypto.randomUUID();
    const res = await request(
      "PATCH",
      `/api/borrow/${validButMissingId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REQUEST_NOT_FOUND");
  });

  it("should return 400 if requestId format is invalid", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PATCH",
      "/api/borrow/not-a-valid-uuid",
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_REQUEST_ID");
  });

  it("should return 400 if status field is missing", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      {},
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 401 if not authenticated", async () => {
    const res = await request(
      "PATCH",
      "/api/borrow/some-request-id",
      { status: BorrowStatus.LENT },
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 for invalid JSON body", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = app.request(
      `/api/borrow/${requestId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token1}`,
        },
        body: "{invalid json}",
      },
      { KV: kv, DEV_MODE: "1" },
    );
    expect((await res).status).toBe(400);
  });

  it("should persist updated status in KV", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );

    const stored = await kv.get(kvKeys.borrow(requestId), "json") as BorrowRequest;
    expect(stored.status).toBe(BorrowStatus.LENT);
  });

  it("should return 422 for invalid target status value", async () => {
    const { familyId, token1, token2 } = await createFamilyWithTwoMembers();
    const requestId = await createPendingBorrowRequest(familyId, token2);

    const res = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: 99 },
      token1,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_STATUS_TRANSITION");
  });
});
