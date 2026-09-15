/**
 * PATCH /api/borrow/:requestId — family membership re-check (issue #159).
 *
 * A borrow record freezes `borrowerId` / `ownerId` at create time, while an
 * auth token binds only a userId. Before the fix the handler authorised solely
 * on "caller is a party", so a member who was kicked or left could create a
 * NEW family, mint a fresh valid token, and still flip an old LENT record to
 * RETURNED — a terminal state nothing can leave. The handler now re-reads
 * `family:{id}` and refuses a non-member BEFORE the party check, with the same
 * `NOT_FAMILY_MEMBER` code the create / list handlers use.
 *
 * The orphan path (family record missing, index left behind by a failed
 * dissolve cleanup) deliberately SKIPS the membership check: with no member
 * list to consult, the party check alone decides, so either party can still
 * settle and a non-party is still refused with plain `FORBIDDEN`.
 *
 * Every refused case also pins "no KV write" via `watchKvOps`: a refusal must
 * leave the index byte-identical, not merely answer 403.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import {
  BorrowStatus,
  kvKeys,
  type BorrowPointer,
  type BorrowRequest,
} from "../../src/kv/schema";
import { ALICE, BOB, CHARLIE } from "../helpers/ids";

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

async function createFamilyAndGetToken(userId: string, displayName: string) {
  const res = await request("POST", "/api/family", { userId, displayName });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function joinFamilyAndGetToken(
  familyId: string,
  userId: string,
  displayName: string,
) {
  const res = await request("POST", `/api/family/${familyId}/join`, {
    userId,
    displayName,
  });
  expect(res.status).toBe(200);
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
      bookCoverUrl: "",
      ownerId,
    },
    borrowerToken,
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return json.data.requestId as string;
}

function patchStatus(requestId: string, status: BorrowStatus, token: string) {
  return request("PATCH", `/api/borrow/${requestId}`, { status }, token);
}

/**
 * Resolve a record the way production does: pointer → family index. Returns
 * `null` when either half is gone.
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
 * Alice owns a family, Bob joins, Bob borrows Alice's book and Alice approves
 * it, so the record is LENT — the state whose only exit is the terminal
 * RETURNED that #159 is about.
 */
async function seedLentRecord() {
  const { familyId, authToken: aliceToken } = await createFamilyAndGetToken(
    ALICE,
    "Alice",
  );
  const { authToken: bobToken } = await joinFamilyAndGetToken(
    familyId,
    BOB,
    "Bob",
  );
  const requestId = await createBorrowRequest(familyId, bobToken, ALICE, "1");
  const approve = await patchStatus(requestId, BorrowStatus.LENT, aliceToken);
  expect(approve.status).toBe(200);
  expect((await readBorrow(requestId))?.status).toBe(BorrowStatus.LENT);
  return { familyId, aliceToken, bobToken, requestId };
}

/** Assert a PATCH was refused with `code`, wrote nothing, and left the record as it was. */
async function expectRefusedUntouched(
  res: Response,
  status: number,
  code: string,
  ops: ReturnType<typeof watchKvOps>,
  requestId: string,
  before: BorrowRequest,
) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as Json).error.code).toBe(code);
  expect(ops.putKeys()).toEqual([]);
  expect(ops.deleteKeys()).toEqual([]);
  const after = await readBorrow(requestId);
  expect(after).toEqual(before);
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  // `watchKvOps` installs spies and does not remove them itself.
  vi.restoreAllMocks();
});

describe("PATCH /api/borrow/:requestId — family membership re-check", () => {
  it("refuses a kicked member holding a fresh token from a new family with 403 NOT_FAMILY_MEMBER", async () => {
    const { familyId, aliceToken, requestId } = await seedLentRecord();

    // Alice kicks Bob. His old token is revoked by the removal, which is why
    // the attack needs a NEW family: creating one mints a valid token again.
    const kick = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(kick.status).toBe(200);

    const { authToken: bobNewToken } = await createFamilyAndGetToken(
      BOB,
      "Bob",
    );

    const before = await readBorrow(requestId);
    expect(before?.status).toBe(BorrowStatus.LENT);

    // Bob IS still a party (borrowerId) — the refusal is the membership check
    // firing BEFORE the party check, not the party check.
    const ops = watchKvOps(kv);
    const res = await patchStatus(
      requestId,
      BorrowStatus.RETURNED,
      bobNewToken,
    );
    await expectRefusedUntouched(
      res,
      403,
      "NOT_FAMILY_MEMBER",
      ops,
      requestId,
      before as BorrowRequest,
    );

    // The remaining party can still close the loan.
    const settle = await patchStatus(
      requestId,
      BorrowStatus.RETURNED,
      aliceToken,
    );
    expect(settle.status).toBe(200);
    expect((await readBorrow(requestId))?.status).toBe(BorrowStatus.RETURNED);
  });

  it("refuses a member who left on their own and joined another family with 403 NOT_FAMILY_MEMBER", async () => {
    const { familyId, bobToken, requestId } = await seedLentRecord();

    // Bob leaves by himself. `settleDepartingBorrower` cancels his PENDING and
    // purges his TERMINAL records, but a LENT one stays — the book may still be
    // out — so the record is still there to be attacked.
    const leave = await request(
      "DELETE",
      `/api/family/${familyId}/member/${BOB}`,
      undefined,
      bobToken,
    );
    expect(leave.status).toBe(200);
    const before = await readBorrow(requestId);
    expect(before?.status).toBe(BorrowStatus.LENT);

    // Bob joins Charlie's family — the JOIN path also mints a valid token.
    const { familyId: charlieFamilyId } = await createFamilyAndGetToken(
      CHARLIE,
      "Charlie",
    );
    const { authToken: bobNewToken } = await joinFamilyAndGetToken(
      charlieFamilyId,
      BOB,
      "Bob",
    );

    const ops = watchKvOps(kv);
    const res = await patchStatus(
      requestId,
      BorrowStatus.RETURNED,
      bobNewToken,
    );
    await expectRefusedUntouched(
      res,
      403,
      "NOT_FAMILY_MEMBER",
      ops,
      requestId,
      before as BorrowRequest,
    );
  });

  it("skips the membership check on an orphan record: a party settles it, a non-party gets plain FORBIDDEN", async () => {
    const { familyId, bobToken, requestId } = await seedLentRecord();

    // Charlie holds a valid token from his OWN family and is a party to nothing
    // in Alice's.
    const { authToken: charlieToken } = await createFamilyAndGetToken(
      CHARLIE,
      "Charlie",
    );

    // Simulate a dissolve whose fail-open `deleteBorrowIndex` did not land:
    // family record gone, index (and pointer) still there. Setup-only surgery;
    // every assertion below goes through HTTP.
    await kv.delete(kvKeys.family(familyId));
    const before = await readBorrow(requestId);
    expect(before?.status).toBe(BorrowStatus.LENT);

    // Non-party: refused by the PARTY check, so the code is FORBIDDEN — not
    // NOT_FAMILY_MEMBER, which would mean a member list was consulted.
    const ops = watchKvOps(kv);
    const charlieRes = await patchStatus(
      requestId,
      BorrowStatus.RETURNED,
      charlieToken,
    );
    await expectRefusedUntouched(
      charlieRes,
      403,
      "FORBIDDEN",
      ops,
      requestId,
      before as BorrowRequest,
    );

    // Party (borrower, ORIGINAL token — nothing revoked it): still allowed.
    const bobRes = await patchStatus(
      requestId,
      BorrowStatus.RETURNED,
      bobToken,
    );
    expect(bobRes.status).toBe(200);
    expect(((await bobRes.json()) as Json).data.status).toBe(
      BorrowStatus.RETURNED,
    );
    expect((await readBorrow(requestId))?.status).toBe(BorrowStatus.RETURNED);
  });

  it("still refuses a current member who is not a party with 403 FORBIDDEN", async () => {
    const { familyId, requestId } = await seedLentRecord();

    // maxMembers defaults to 2 and no route raises it — bump it in KV so
    // Charlie can join as a third, uninvolved member.
    const raw = await kv.get<Json>(kvKeys.family(familyId), "json");
    raw.maxMembers = 3;
    await kv.put(kvKeys.family(familyId), JSON.stringify(raw));
    const { authToken: charlieToken } = await joinFamilyAndGetToken(
      familyId,
      CHARLIE,
      "Charlie",
    );

    const before = await readBorrow(requestId);
    expect(before?.status).toBe(BorrowStatus.LENT);

    // Pins the ORDER: membership passes (Charlie is a member), so the refusal
    // comes from the party check with its own code.
    const ops = watchKvOps(kv);
    const res = await patchStatus(
      requestId,
      BorrowStatus.RETURNED,
      charlieToken,
    );
    await expectRefusedUntouched(
      res,
      403,
      "FORBIDDEN",
      ops,
      requestId,
      before as BorrowRequest,
    );
  });
});
