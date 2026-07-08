import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { BorrowStatus, kvKeys, type BorrowRequest } from "../../src/kv/schema";
import { ALICE, BOB, CHARLIE } from "../helpers/ids";

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

async function createFamilyAndGetToken(userId: string, displayName = "") {
  const res = await request("POST", "/api/family", { userId, displayName });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function joinFamilyAndGetToken(familyId: string, userId: string, displayName = "") {
  const res = await request("POST", `/api/family/${familyId}/join`, { userId, displayName });
  const json = (await res.json()) as Json;
  return { authToken: json.data.authToken as string };
}

async function createBorrowRequest(
  familyId: string,
  borrowerToken: string,
  ownerId: string,
  bookSuffix: string,
): Promise<string> {
  const res = await request(
    "POST",
    `/api/family/${familyId}/borrow`,
    {
      bookId: `book-${bookSuffix}`,
      bookTitle: `Book ${bookSuffix}`,
      bookAuthor: "Author",
      bookCoverUrl: "https://example.com/cover.jpg",
      ownerId,
    },
    borrowerToken,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return json.data.requestId as string;
}

async function readBorrow(requestId: string): Promise<BorrowRequest | null> {
  return await kv.get<BorrowRequest>(kvKeys.borrow(requestId), "json");
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Auto-cancel PENDING borrow requests on member removal
// ===========================================================================

describe("Borrow Cancellation on Member Removal", () => {
  it("auto-cancels PENDING requests where removed member is borrower OR owner", async () => {
    // 3-person family: Alice (owner), Bob, Carol
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(ALICE, "Alice");

    // Bump maxMembers to 3 directly in KV so we can have Alice + Bob + Carol
    const raw = await kv.get<Json>(kvKeys.family(familyId), "json");
    raw.maxMembers = 3;
    await kv.put(kvKeys.family(familyId), JSON.stringify(raw));

    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");
    const { authToken: carolToken } = await joinFamilyAndGetToken(familyId, CHARLIE, "Carol");

    // Bob borrows from Alice (Bob = borrower)
    const reqBobBorrows = await createBorrowRequest(familyId, bobToken, ALICE, "1");
    // Carol borrows from Bob (Bob = owner)
    const reqBobOwns = await createBorrowRequest(familyId, carolToken, BOB, "2");
    // Carol borrows from Alice (Bob is unrelated)
    const reqUnrelated = await createBorrowRequest(familyId, carolToken, ALICE, "3");

    // Alice removes Bob
    const removeRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(removeRes.status).toBe(200);

    // Verify Bob's borrow requests are CANCELLED
    expect((await readBorrow(reqBobBorrows))?.status).toBe(BorrowStatus.CANCELLED);
    expect((await readBorrow(reqBobOwns))?.status).toBe(BorrowStatus.CANCELLED);

    // Unrelated request stays PENDING
    expect((await readBorrow(reqUnrelated))?.status).toBe(BorrowStatus.PENDING);
  });

  it("preserves LENT requests when a member is removed", async () => {
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");

    // Bob borrows from Alice → PENDING
    const requestId = await createBorrowRequest(familyId, bobToken, ALICE, "lent");

    // Alice approves → LENT
    const approveRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.LENT },
      aliceToken,
    );
    expect(approveRes.status).toBe(200);

    // Alice removes Bob
    const removeRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(removeRes.status).toBe(200);

    // LENT status MUST be preserved
    const after = await readBorrow(requestId);
    expect(after?.status).toBe(BorrowStatus.LENT);
  });

  it("only cancels PENDING; leaves LENT and REJECTED unchanged on member removal", async () => {
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");

    // Three Bob-involving requests in different states
    const pendingId = await createBorrowRequest(familyId, bobToken, ALICE, "pending");
    const lentId = await createBorrowRequest(familyId, bobToken, ALICE, "lent");
    const rejectedId = await createBorrowRequest(familyId, bobToken, ALICE, "rejected");

    await request(
      "PATCH",
      `/api/borrow/${lentId}`,
      { status: BorrowStatus.LENT },
      aliceToken,
    );
    await request(
      "PATCH",
      `/api/borrow/${rejectedId}`,
      { status: BorrowStatus.REJECTED },
      aliceToken,
    );

    // Sanity check pre-removal
    expect((await readBorrow(pendingId))?.status).toBe(BorrowStatus.PENDING);
    expect((await readBorrow(lentId))?.status).toBe(BorrowStatus.LENT);
    expect((await readBorrow(rejectedId))?.status).toBe(BorrowStatus.REJECTED);

    // Alice removes Bob
    const removeRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(removeRes.status).toBe(200);

    // Only PENDING should be CANCELLED; others unchanged
    expect((await readBorrow(pendingId))?.status).toBe(BorrowStatus.CANCELLED);
    expect((await readBorrow(lentId))?.status).toBe(BorrowStatus.LENT);
    expect((await readBorrow(rejectedId))?.status).toBe(BorrowStatus.REJECTED);
  });

  it("succeeds even when family has no borrow index", async () => {
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    // No borrow requests exist; removing Bob should still succeed without errors
    const removeRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(removeRes.status).toBe(200);
    const json = (await removeRes.json()) as Json;
    expect(json.data.members).toEqual([{ userId: ALICE, displayName: "Alice", canLend: 1 }]);

    // Confirm there is still no borrow index
    const idx = await kv.get(kvKeys.borrowsByFamily(familyId));
    expect(idx).toBeNull();
  });
});
