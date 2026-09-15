import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import {
  BorrowStatus,
  kvKeys,
  type BorrowPointer,
  type BorrowRequest,
} from "../../src/kv/schema";
import { ALICE, BOB, CHARLIE, DAVE } from "../helpers/ids";

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
      // `bookCoverUrl` is optional, but a SUPPLIED non-empty value must clear
      // `isAllowedCoverUrl` — the create handler refuses an off-Readmoo host
      // with 400 INVALID_COVER_URL, which would never reach the removal logic
      // these cases are about.
      bookCoverUrl: `https://cdn.readmoo.com/cover/${bookSuffix}.jpg`,
      ownerId,
    },
    borrowerToken,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return json.data.requestId as string;
}

/**
 * Read a borrow record the way production resolves one since the index was
 * denormalised (#160 item 2, `src/services/borrowIndex.ts`): `borrow:{id}` is
 * only a `{ familyId }` pointer, and the family's index
 * (`borrows:family:{familyId}`) is the single source of truth for status and
 * fields. Reading the pointer alone would assert against an object that has
 * neither, which is exactly the drift this two-step lookup prevents.
 *
 * Returns `null` when the pointer is gone (never written / deleted by a trim)
 * or when the index no longer carries the record.
 */
async function readBorrow(requestId: string): Promise<BorrowRequest | null> {
  const pointer = await kv.get<BorrowPointer>(kvKeys.borrow(requestId), "json");
  if (!pointer?.familyId) return null;
  const index = await kv.get<BorrowRequest[]>(
    kvKeys.borrowsByFamily(pointer.familyId),
    "json",
  );
  return index?.find((r) => r.requestId === requestId) ?? null;
}

/**
 * The requestIds the family's stored index currently names, in index order —
 * readable in EITHER shape (`string[]` legacy, records since #160 item 2).
 *
 * Since the departure settlement (`settleDepartingBorrower`) PURGES a leaver's
 * own terminal records, "was this record cancelled?" and "is this record still
 * here?" are now two different questions. `readBorrow` answers the first only
 * while the record survives; this answers the second directly.
 */
async function storedIndexIds(familyId: string): Promise<string[]> {
  const stored = await kv.get<BorrowRequest[] | string[]>(
    kvKeys.borrowsByFamily(familyId),
    "json",
  );
  if (!stored) return [];
  return stored.map((entry) =>
    typeof entry === "string" ? entry : entry.requestId,
  );
}

/**
 * GET the family borrow list as `token`. Returns the parsed records plus the
 * raw response text, so a test can assert that a userId appears NOWHERE in the
 * payload (not just outside the fields it happens to check).
 */
async function listBorrows(familyId: string, token: string) {
  const res = await request(
    "GET",
    `/api/family/${familyId}/borrow`,
    undefined,
    token,
  );
  expect(res.status).toBe(200);
  const body = await res.text();
  return { body, data: (JSON.parse(body) as Json).data as BorrowRequest[] };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Auto-cancel PENDING borrow requests on member removal
// ===========================================================================

describe("Borrow Cancellation on Member Removal", () => {
  it("cancels PENDING requests on both sides and purges the ones the removed member borrowed", async () => {
    // 3-person family: Alice (owner), Bob, Carol
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(
      ALICE,
      "Alice",
    );

    // Bump maxMembers to 3 directly in KV so we can have Alice + Bob + Carol
    const raw = await kv.get<Json>(kvKeys.family(familyId), "json");
    raw.maxMembers = 3;
    await kv.put(kvKeys.family(familyId), JSON.stringify(raw));

    const { authToken: bobToken } = await joinFamilyAndGetToken(
      familyId,
      BOB,
      "Bob",
    );
    const { authToken: carolToken } = await joinFamilyAndGetToken(
      familyId,
      CHARLIE,
      "Carol",
    );

    // Bob borrows from Alice (Bob = borrower)
    const reqBobBorrows = await createBorrowRequest(
      familyId,
      bobToken,
      ALICE,
      "1",
    );
    // Carol borrows from Bob (Bob = owner)
    const reqBobOwns = await createBorrowRequest(
      familyId,
      carolToken,
      BOB,
      "2",
    );
    // Carol borrows from Alice (Bob is unrelated)
    const reqUnrelated = await createBorrowRequest(
      familyId,
      carolToken,
      ALICE,
      "3",
    );

    // Alice removes Bob
    const removeRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(removeRes.status).toBe(200);

    // (a) Bob was the BORROWER: the request is cancelled AND then purged in the
    // same settlement — index entry and pointer both gone. That purge is the
    // fix for security finding F-1: the history cap is keyed on `borrowerId`,
    // so a leaver's finished records would otherwise sit in the shared index
    // under an id that never writes again and can never be trimmed.
    expect(await storedIndexIds(familyId)).not.toContain(reqBobBorrows);
    expect(await kv.get(kvKeys.borrow(reqBobBorrows))).toBeNull();
    expect(await readBorrow(reqBobBorrows)).toBeNull();

    // (b) Bob was the OWNER: the record is CAROL's own history, so it survives —
    // and it is where the CANCELLATION half of the settlement stays observable
    // now that the borrower-side record is purged before anyone can read it.
    expect(await storedIndexIds(familyId)).toContain(reqBobOwns);
    expect((await readBorrow(reqBobOwns))?.status).toBe(BorrowStatus.CANCELLED);

    // (c) Unrelated request stays PENDING
    expect(await storedIndexIds(familyId)).toContain(reqUnrelated);
    expect((await readBorrow(reqUnrelated))?.status).toBe(BorrowStatus.PENDING);
  });

  it("preserves LENT requests when a member is removed", async () => {
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(
      ALICE,
      "Alice",
    );
    const { authToken: bobToken } = await joinFamilyAndGetToken(
      familyId,
      BOB,
      "Bob",
    );

    // Bob borrows from Alice → PENDING
    const requestId = await createBorrowRequest(
      familyId,
      bobToken,
      ALICE,
      "lent",
    );

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

  it("purges the removed member's PENDING and REJECTED records but keeps their LENT one", async () => {
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(
      ALICE,
      "Alice",
    );
    const { authToken: bobToken } = await joinFamilyAndGetToken(
      familyId,
      BOB,
      "Bob",
    );

    // Three Bob-involving requests in different states
    const pendingId = await createBorrowRequest(
      familyId,
      bobToken,
      ALICE,
      "pending",
    );
    const lentId = await createBorrowRequest(familyId, bobToken, ALICE, "lent");
    const rejectedId = await createBorrowRequest(
      familyId,
      bobToken,
      ALICE,
      "rejected",
    );

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

    // All three are Bob's OWN borrows, so the settlement judges them by status:
    // PENDING is cancelled (making it terminal) and REJECTED already was, so
    // both are purged; LENT is the only survivor — the book may still be
    // physically out on loan and the counterparty must be able to close it.
    expect(await storedIndexIds(familyId)).toEqual([lentId]);
    expect(await kv.get(kvKeys.borrow(pendingId))).toBeNull();
    expect(await kv.get(kvKeys.borrow(rejectedId))).toBeNull();

    // Positive companion for the two `toBeNull()` lines: the survivor keeps
    // BOTH halves, so they cannot be green because the removal wiped
    // everything.
    expect(await kv.get(kvKeys.borrow(lentId))).not.toBeNull();
    expect((await readBorrow(lentId))?.status).toBe(BorrowStatus.LENT);
  });

  it("succeeds even when family has no borrow index", async () => {
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(
      ALICE,
      "Alice",
    );
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
    expect(json.data.members).toEqual([
      { userId: ALICE, displayName: "Alice", canLend: 1 },
    ]);

    // Confirm there is still no borrow index
    const idx = await kv.get(kvKeys.borrowsByFamily(familyId));
    expect(idx).toBeNull();
  });
});

// ===========================================================================
// A removed member's borrow data must not stay visible to uninvolved members
// ===========================================================================

describe("Borrow visibility after member removal", () => {
  it("keeps a removed member's record with its counterparty and out of an uninvolved member's list", async () => {
    // 4-person family: Alice (family owner), Bob, Carol, Dave
    const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(
      ALICE,
      "Alice",
    );

    // maxMembers defaults to 2 and no route raises it — bump it in KV so the
    // family can hold four members. Setup only; every assertion below goes
    // through the HTTP handlers.
    const raw = await kv.get<Json>(kvKeys.family(familyId), "json");
    raw.maxMembers = 4;
    await kv.put(kvKeys.family(familyId), JSON.stringify(raw));

    await joinFamilyAndGetToken(familyId, BOB, "Bob");
    const { authToken: carolToken } = await joinFamilyAndGetToken(
      familyId,
      CHARLIE,
      "Carol",
    );
    const { authToken: daveToken } = await joinFamilyAndGetToken(
      familyId,
      DAVE,
      "Dave",
    );

    // Both records must exist BEFORE the removal: POST requires the ownerId to
    // be a current family member.
    // Carol borrows Bob's book — Bob is about to be removed.
    const reqCarolBorrowsBob = await createBorrowRequest(
      familyId,
      carolToken,
      BOB,
      "bob",
    );
    // Dave borrows Alice's book — Dave's own record, unrelated to Bob.
    const reqDaveBorrowsAlice = await createBorrowRequest(
      familyId,
      daveToken,
      ALICE,
      "alice",
    );

    // Alice removes Bob
    const removeRes = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(removeRes.status).toBe(200);

    // (a) The PENDING record involving Bob is cancelled, but survives in KV.
    expect((await readBorrow(reqCarolBorrowsBob))?.status).toBe(
      BorrowStatus.CANCELLED,
    );

    // (a2) It survives specifically in the family INDEX, which the cancellation
    // rewrote. This is the positive companion for (b) below: the removed
    // member's data is still there to leak, so an empty/filtered response is
    // the API-layer least-privilege filter doing its job — not a deletion that
    // would make (b) pass vacuously.
    const index = await kv.get<BorrowRequest[]>(
      kvKeys.borrowsByFamily(familyId),
      "json",
    );
    expect(index?.map((r) => r.requestId)).toContain(reqCarolBorrowsBob);
    expect(index?.some((r) => r.ownerId === BOB)).toBe(true);

    // (b) Dave, a party to neither, sees only his own record — nothing about
    // the removed member reaches him, in any field.
    const daveView = await listBorrows(familyId, daveToken);
    expect(daveView.data.map((r) => r.requestId)).toEqual([
      reqDaveBorrowsAlice,
    ]);
    expect(daveView.body).not.toContain(BOB);

    // (c) Carol, the counterparty, keeps her history with the removed member.
    const carolView = await listBorrows(familyId, carolToken);
    expect(carolView.data).toHaveLength(1);
    expect(carolView.data[0].requestId).toBe(reqCarolBorrowsBob);
    expect(carolView.data[0].ownerId).toBe(BOB);
    expect(carolView.data[0].status).toBe(BorrowStatus.CANCELLED);
  });
});

// ===========================================================================
// Orphaned borrow records outlive their family record
// ===========================================================================

describe("Orphaned borrow records after family dissolution", () => {
  it("lets a party settle an orphaned request while a non-party stays forbidden", async () => {
    const { familyId } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(
      familyId,
      BOB,
      "Bob",
    );

    // Carol is an authenticated user in her OWN family — a party to nothing in
    // Alice's family, but holding a token the auth middleware accepts.
    const { authToken: carolToken } = await createFamilyAndGetToken(
      CHARLIE,
      "Carol",
    );

    // Bob borrows Alice's book → PENDING
    const requestId = await createBorrowRequest(
      familyId,
      bobToken,
      ALICE,
      "orphan",
    );

    // Dissolve the family by dropping `family:{familyId}`. Setup-only KV
    // surgery; every assertion below still goes through HTTP. Auth tokens live
    // in `auth:{userId}` / `authtoken:{token}` and only member removal deletes
    // them, so Bob's token survives the family record — that is precisely the
    // residual being pinned here.
    await kv.delete(kvKeys.family(familyId));

    // Sanity: the family really is gone — a family-scoped route now 404s.
    const listRes = await request(
      "GET",
      `/api/family/${familyId}/borrow`,
      undefined,
      bobToken,
    );
    expect(listRes.status).toBe(404);
    expect(((await listRes.json()) as Json).error.code).toBe(
      "FAMILY_NOT_FOUND",
    );

    // A non-party is still refused, and the refusal discloses nothing about the
    // orphan (no counterparty id leaks into the error body).
    const carolRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      carolToken,
    );
    expect(carolRes.status).toBe(403);
    const carolBody = await carolRes.text();
    expect((JSON.parse(carolBody) as Json).error.code).toBe("FORBIDDEN");
    expect(carolBody).not.toContain(BOB);
    expect(carolBody).not.toContain(ALICE);
    // The refused write left the record untouched.
    expect((await readBorrow(requestId))?.status).toBe(BorrowStatus.PENDING);

    // The borrower CAN still cancel: PATCH /api/borrow/:requestId does re-read
    // `family:{familyId}` for its membership check (#159), but the key is
    // ABSENT here — that is what makes this an orphan — so the check is
    // skipped and the party check alone authorises. The orphan stays writable
    // by its parties (see tests/integration/borrowMembershipRecheck.test.ts).
    const cancelRes = await request(
      "PATCH",
      `/api/borrow/${requestId}`,
      { status: BorrowStatus.CANCELLED },
      bobToken,
    );
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as Json).data.status).toBe(
      BorrowStatus.CANCELLED,
    );
    expect((await readBorrow(requestId))?.status).toBe(BorrowStatus.CANCELLED);
  });
});
