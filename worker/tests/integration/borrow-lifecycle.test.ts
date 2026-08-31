import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { BorrowStatus } from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

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

async function createFamilyAndGetToken(userId: string, displayName = "") {
  const res = await request("POST", "/api/family", { userId, displayName });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function joinFamilyAndGetToken(
  familyId: string,
  userId: string,
  displayName = "",
) {
  const res = await request("POST", `/api/family/${familyId}/join`, {
    userId,
    displayName,
  });
  const json = (await res.json()) as Json;
  return { authToken: json.data.authToken as string };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Borrow Lifecycle: PENDING → LENT → RETURNED
// ===========================================================================
//
// `bookCoverUrl` is OPTIONAL, but every value SUPPLIED below sits on a Readmoo
// host on purpose: the create handler runs `isAllowedCoverUrl`
// (shared/src/config/readmoo.ts) on every non-empty value and refuses anything
// else with 400 INVALID_COVER_URL, which would never reach the lifecycle logic
// these cases are about. The cover-less variant gets its own case at the end of
// this block; rejection cases live in `tests/unit/borrow.test.ts`.

describe("Borrow Lifecycle Integration", () => {
  it("should complete full lifecycle: create family → add members → create borrow → approve → return", async () => {
    // Step 1: Create family with user1 as owner
    const { familyId, authToken: token1 } = await createFamilyAndGetToken(
      USER1,
      "Alice",
    );

    // Step 2: user2 joins the family
    const { authToken: token2 } = await joinFamilyAndGetToken(
      familyId,
      USER2,
      "Bob",
    );

    // Verify both members are in the family
    const membersRes = await request(
      "GET",
      `/api/family/${familyId}/members`,
      undefined,
      token1,
    );
    expect(membersRes.status).toBe(200);
    const membersJson = (await membersRes.json()) as Json;
    expect(membersJson.data.members).toHaveLength(2);

    // Step 3: user2 creates a borrow request for one of user1's books
    const borrowBody = {
      bookId: "book-abc",
      bookTitle: "TypeScript Handbook",
      bookAuthor: "Microsoft",
      bookCoverUrl: "https://cdn.readmoo.com/cover/ts-cover.jpg",
      ownerId: USER1,
    };

    const createRes = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      borrowBody,
      token2,
    );
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as Json;
    const requestId = createJson.data.requestId;

    expect(createJson.data.status).toBe(BorrowStatus.PENDING);
    expect(createJson.data.borrowerId).toBe(USER2);
    expect(createJson.data.borrowerName).toBe("Bob");
    expect(createJson.data.ownerId).toBe(USER1);

    // Step 4: Verify the request shows up in GET list
    const listRes1 = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token1,
    );
    expect(listRes1.status).toBe(200);
    const listJson1 = (await listRes1.json()) as Json;
    expect(listJson1.data).toHaveLength(1);
    expect(listJson1.data[0].requestId).toBe(requestId);
    expect(listJson1.data[0].status).toBe(BorrowStatus.PENDING);

    // Step 5: Owner (user1) approves → LENT
    const lentRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(lentRes.status).toBe(200);
    const lentJson = (await lentRes.json()) as Json;
    expect(lentJson.data.status).toBe(BorrowStatus.LENT);

    // Step 6: Verify status change via GET list
    const listRes2 = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token2,
    );
    expect(listRes2.status).toBe(200);
    const listJson2 = (await listRes2.json()) as Json;
    expect(listJson2.data[0].status).toBe(BorrowStatus.LENT);

    // Step 7: Either party marks as RETURNED (borrower does it)
    const returnRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token2,
    );
    expect(returnRes.status).toBe(200);
    const returnJson = (await returnRes.json()) as Json;
    expect(returnJson.data.status).toBe(BorrowStatus.RETURNED);

    // Step 8: Verify final state
    const listRes3 = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token1,
    );
    expect(listRes3.status).toBe(200);
    const listJson3 = (await listRes3.json()) as Json;
    expect(listJson3.data[0].status).toBe(BorrowStatus.RETURNED);

    // Step 9: RETURNED is terminal — cannot transition further
    const invalidRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(invalidRes.status).toBe(422);
  });

  it("should complete the rejection flow: PENDING → REJECTED", async () => {
    const { familyId, authToken: token1 } = await createFamilyAndGetToken(
      USER1,
      "Alice",
    );
    const { authToken: token2 } = await joinFamilyAndGetToken(
      familyId,
      USER2,
      "Bob",
    );

    // Create a borrow request
    const createRes = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      {
        bookId: "book-xyz",
        bookTitle: "Rejected Book",
        bookAuthor: "Author",
        bookCoverUrl: "https://cdn.readmoo.com/cover/rejected.jpg",
        ownerId: USER1,
      },
      token2,
    );
    expect(createRes.status).toBe(201);
    const { requestId } = ((await createRes.json()) as Json).data;

    // Owner rejects
    const rejectRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.REJECTED },
      token1,
    );
    expect(rejectRes.status).toBe(200);
    expect(((await rejectRes.json()) as Json).data.status).toBe(
      BorrowStatus.REJECTED,
    );

    // REJECTED is terminal
    const retryRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(retryRes.status).toBe(422);
  });

  it("should complete the cancellation flow: PENDING → CANCELLED", async () => {
    const { familyId } = await createFamilyAndGetToken(USER1, "Alice");
    const { authToken: token2 } = await joinFamilyAndGetToken(
      familyId,
      USER2,
      "Bob",
    );

    // Create a borrow request
    const createRes = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      {
        bookId: "book-cancel",
        bookTitle: "Cancelled Book",
        bookAuthor: "Author",
        bookCoverUrl: "https://cdn.readmoo.com/cover/cancelled.jpg",
        ownerId: USER1,
      },
      token2,
    );
    expect(createRes.status).toBe(201);
    const { requestId } = ((await createRes.json()) as Json).data;

    // Borrower cancels
    const cancelRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      token2,
    );
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as Json).data.status).toBe(
      BorrowStatus.CANCELLED,
    );

    // CANCELLED is terminal
    const retryRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.PENDING },
      token2,
    );
    expect(retryRes.status).toBe(422);
  });

  it("should handle multiple concurrent borrow requests for different books", async () => {
    const { familyId, authToken: token1 } = await createFamilyAndGetToken(
      USER1,
      "Alice",
    );
    const { authToken: token2 } = await joinFamilyAndGetToken(
      familyId,
      USER2,
      "Bob",
    );

    const books = [
      {
        bookId: "book-1",
        bookTitle: "Book One",
        bookAuthor: "Author 1",
        bookCoverUrl: "https://cdn.readmoo.com/cover/1.jpg",
      },
      {
        bookId: "book-2",
        bookTitle: "Book Two",
        bookAuthor: "Author 2",
        bookCoverUrl: "https://cdn.readmoo.com/cover/2.jpg",
      },
      {
        bookId: "book-3",
        bookTitle: "Book Three",
        bookAuthor: "Author 3",
        bookCoverUrl: "https://cdn.readmoo.com/cover/3.jpg",
      },
    ];

    // Create 3 borrow requests
    const requestIds: string[] = [];
    for (const book of books) {
      const res = await request(
        "POST",
        `/api/family/${familyId}/borrow`,
        { ...book, ownerId: USER1 },
        token2,
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as Json;
      requestIds.push(json.data.requestId);
    }

    // List should show 3 requests
    const listRes = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token1,
    );
    expect(((await listRes.json()) as Json).data).toHaveLength(3);

    // Approve first, reject second, leave third pending
    await request(
      "PATCH",
      `/api/borrow/${requestIds[0]}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    await request(
      "PATCH",
      `/api/borrow/${requestIds[1]}`,
      { status: BorrowStatus.REJECTED },
      token1,
    );

    // Verify statuses
    const listRes2 = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token2,
    );
    const data = ((await listRes2.json()) as Json).data;
    expect(data.find((r: Json) => r.requestId === requestIds[0]).status).toBe(
      BorrowStatus.LENT,
    );
    expect(data.find((r: Json) => r.requestId === requestIds[1]).status).toBe(
      BorrowStatus.REJECTED,
    );
    expect(data.find((r: Json) => r.requestId === requestIds[2]).status).toBe(
      BorrowStatus.PENDING,
    );
  });

  it("should run the full lifecycle for a cover-less book, keeping bookCoverUrl empty end to end", async () => {
    // The bookshelf aggregation sanitizes an off-whitelist cover to "" and the
    // clients forward that verbatim, so this is exactly the payload a book with
    // no renderable cover produces. It used to be answered 400 MISSING_FIELDS,
    // making such books permanently unborrowable.
    const { familyId, authToken: token1 } = await createFamilyAndGetToken(
      USER1,
      "Alice",
    );
    const { authToken: token2 } = await joinFamilyAndGetToken(
      familyId,
      USER2,
      "Bob",
    );

    const createRes = await request(
      "POST",
      `/api/family/${familyId}/borrow`,
      {
        bookId: "book-no-cover",
        bookTitle: "Cover-less Book",
        bookAuthor: "Author",
        bookCoverUrl: "",
        ownerId: USER1,
      },
      token2,
    );
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as Json;
    const requestId = createJson.data.requestId;
    expect(createJson.data.bookCoverUrl).toBe("");

    // The owner sees the request in their list with the empty cover intact.
    const listRes = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      token1,
    );
    const listJson = (await listRes.json()) as Json;
    expect(listJson.data).toHaveLength(1);
    expect(listJson.data[0].bookCoverUrl).toBe("");

    // PENDING → LENT → RETURNED, and the empty cover survives both PATCH
    // rewrites of the record.
    const lentRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      token1,
    );
    expect(lentRes.status).toBe(200);

    const returnRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.RETURNED },
      token2,
    );
    expect(returnRes.status).toBe(200);
    const returnJson = (await returnRes.json()) as Json;
    expect(returnJson.data.status).toBe(BorrowStatus.RETURNED);
    expect(returnJson.data.bookCoverUrl).toBe("");
  });
});
