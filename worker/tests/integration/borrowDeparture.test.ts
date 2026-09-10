/**
 * The DEPARTURE SETTLEMENT — what a member leaving does to the family borrow
 * index, end to end through the HTTP handlers.
 *
 * Two service entry points, four call sites (`src/services/borrowIndex.ts`):
 * - `settleDepartingBorrower` — cancel every PENDING request the leaver is
 *   either side of, then PURGE from the index every TERMINAL record they
 *   BORROWED (the just-cancelled ones included) and delete those pointers.
 *   Called by `DELETE /api/family/:id/member/:uid` and by the multi-member
 *   branch of `DELETE /api/user/:id`.
 * - `deleteBorrowIndex` — drop the whole index plus every pointer it names.
 *   Called by both DISSOLVE branches (sole-owner leave, sole-member account
 *   deletion), where the family key itself goes away.
 *
 * WHY THE PURGE EXISTS (security finding F-1). `BORROW_HISTORY_KEEP` is capped
 * per `borrowerId` and a borrowerId is free to mint: join with a fresh userId,
 * open requests, leave — every one of them became a CANCELLED record under an
 * id that would never write again, so its group could never be trimmed. The
 * index is ONE KV value with a 25 MiB ceiling, so that loop grew it with no
 * reclaim path. The end-to-end loop is pinned separately, in
 * tests/integration/borrowIndexReclaim.test.ts; this file pins the settlement's
 * own rules.
 *
 * WHAT MUST NOT HAPPEN, and is asserted throughout: the leaver's OWNER-side
 * records survive. They are the remaining member's own history, they count
 * against THAT borrower's cap, and purging by `ownerId` would hand a leaver a
 * lever to delete another member's records on the way out. LENT survives in
 * BOTH directions — the book may still physically be out on loan.
 *
 * DEV_MODE is on for every request: rate limiting is not what these cases are
 * about, and its counter writes would pollute the `watchKvOps` assertions (see
 * the scope caveat at the end of tests/helpers/kvOps.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import {
  BoolFlag,
  BorrowStatus,
  kvKeys,
  type BorrowPointer,
  type BorrowRequest,
  type FamilyMember,
  type FamilyRecord,
} from "../../src/kv/schema";
import { ALICE, BOB, CHARLIE } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const FAMILY_ID = "abcd-1234";
const BASE_MS = Date.parse("2026-03-01T12:00:00.000Z");

/** How the family's borrow index is stored — before vs after #160 item 2. */
type IndexShape = "new" | "legacy";

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
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Deterministic v4-shaped requestId (RequestIdSchema, src/schemas/common.ts). */
function requestIdAt(index: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`;
}

/** BOB borrows ALICE's book; timestamps grow with `index`. */
function makeRecord(
  index: number,
  overrides: Partial<BorrowRequest> = {},
): BorrowRequest {
  const at = new Date(BASE_MS + index * 1000).toISOString();
  return {
    requestId: requestIdAt(index),
    familyId: FAMILY_ID,
    borrowerId: BOB,
    borrowerName: "Bob",
    ownerId: ALICE,
    bookId: `book-${index}`,
    bookTitle: `Book ${index}`,
    bookAuthor: "Author",
    bookCoverUrl: "",
    status: BorrowStatus.PENDING,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const member = (userId: string, displayName: string): FamilyMember => ({
  userId,
  displayName,
  canLend: BoolFlag.TRUE,
});

/** ALICE always owns the family; `others` join her. */
async function seedFamily(others: FamilyMember[] = []): Promise<void> {
  const record: FamilyRecord = {
    familyId: FAMILY_ID,
    ownerId: ALICE,
    members: [member(ALICE, "Alice"), ...others],
    maxMembers: 1 + others.length,
    createdAt: new Date(BASE_MS).toISOString(),
  };
  await kv.put(kvKeys.family(FAMILY_ID), JSON.stringify(record));
  for (const m of record.members) {
    await kv.put(kvKeys.member(m.userId), FAMILY_ID);
  }
}

/** Seed the index in either shape, with one `borrow:{id}` key per record. */
async function seedIndex(
  records: BorrowRequest[],
  shape: IndexShape = "new",
): Promise<void> {
  for (const record of records) {
    const pointer: BorrowPointer = { familyId: FAMILY_ID };
    await kv.put(
      kvKeys.borrow(record.requestId),
      JSON.stringify(shape === "new" ? pointer : record),
    );
  }
  await kv.put(
    kvKeys.borrowsByFamily(FAMILY_ID),
    JSON.stringify(shape === "new" ? records : records.map((r) => r.requestId)),
  );
}

/** The stored index, parsed as records (only used where it is new-shape). */
async function storedRecords(): Promise<BorrowRequest[] | null> {
  return await kv.get<BorrowRequest[]>(
    kvKeys.borrowsByFamily(FAMILY_ID),
    "json",
  );
}

const ids = (records: BorrowRequest[]): string[] =>
  records.map((r) => r.requestId);

/** Every `borrow:{requestId}` pointer key still present in KV. */
async function livePointerKeys(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys.map((k) => k.name).filter((name) => name.startsWith("borrow:"));
}

/**
 * A KV whose `delete` rejects for keys matching `failing`, and behaves normally
 * otherwise. The selectivity is the point: the removal handler's OWN deletes
 * (member key, auth token) must still land, or the 200 under test would be
 * proving something else.
 */
function failDeletesMatching(predicate: (key: string) => boolean): void {
  const realDelete = kv.delete.bind(kv);
  vi.spyOn(kv, "delete").mockImplementation(async (key: string) => {
    if (predicate(key)) throw new Error(`KV delete rejected: ${key}`);
    await realDelete(key);
  });
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// The full settlement, on the two routes that reach it
// ===========================================================================

/**
 * One index covering every branch of the settlement at once, in index order.
 * BOB is the departing member throughout.
 */
function departureFixture() {
  const bobPending = makeRecord(0); // BOB borrows → cancelled, then purged
  const bobReturned = makeRecord(1, { status: BorrowStatus.RETURNED }); // purged
  const bobLent = makeRecord(2, { status: BorrowStatus.LENT }); // kept
  const bobOwnsLent = makeRecord(3, {
    borrowerId: CHARLIE,
    borrowerName: "Carol",
    ownerId: BOB,
    status: BorrowStatus.LENT,
  }); // kept — LENT survives on the owner side too
  const bobOwnsPending = makeRecord(4, {
    borrowerId: CHARLIE,
    borrowerName: "Carol",
    ownerId: BOB,
  }); // cancelled, but KEPT: it is CAROL's record
  const bobOwnsReturned = makeRecord(5, {
    borrowerId: CHARLIE,
    borrowerName: "Carol",
    ownerId: BOB,
    status: BorrowStatus.RETURNED,
  }); // kept — CAROL's own finished history
  const unrelated = makeRecord(6, {
    borrowerId: CHARLIE,
    borrowerName: "Carol",
    status: BorrowStatus.RETURNED,
  }); // kept — BOB is no party to it

  const all = [
    bobPending,
    bobReturned,
    bobLent,
    bobOwnsLent,
    bobOwnsPending,
    bobOwnsReturned,
    unrelated,
  ];
  return {
    all,
    purged: [bobPending, bobReturned],
    kept: [bobLent, bobOwnsLent, bobOwnsPending, bobOwnsReturned, unrelated],
    cancelledButKept: bobOwnsPending,
    bobLent,
  };
}

/**
 * Both removal callers reach the SAME settlement: the owner kicking a member,
 * and that member walking out on their own. Running the identical fixture
 * through both is what stops the purge from being wired to one branch only.
 */
describe.each([
  { label: "the owner removes a member", caller: ALICE },
  { label: "a member leaves voluntarily", caller: BOB },
])("DELETE /api/family/:id/member/:uid — $label", ({ caller }) => {
  it("purges the leaver's own finished records and keeps everyone else's", async () => {
    await seedFamily([member(BOB, "Bob"), member(CHARLIE, "Carol")]);
    const fixture = departureFixture();
    await seedIndex(fixture.all);
    const callerToken = await seedAuthToken(kv, caller);
    if (caller !== BOB) await seedAuthToken(kv, BOB);

    const ops = watchKvOps(kv);
    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${BOB}`,
      undefined,
      callerToken,
    );
    expect(res.status).toBe(200);

    const index = (await storedRecords()) ?? [];
    expect(ids(index)).toEqual(ids(fixture.kept));

    // The CANCELLATION half stays observable on the record BOB merely OWNED.
    const cancelled = index.find(
      (r) => r.requestId === fixture.cancelledButKept.requestId,
    );
    expect(cancelled?.status).toBe(BorrowStatus.CANCELLED);
    // LENT is untouched in BOTH directions.
    expect(index.filter((r) => r.status === BorrowStatus.LENT)).toHaveLength(2);

    // The PURGE half: one pointer delete per evicted record, and only those.
    expect(await livePointerKeys()).toEqual(
      ids(fixture.kept).map(kvKeys.borrow),
    );

    // Write ORDER is load-bearing: the index put lands FIRST, so no surviving
    // entry is ever left without its pointer. The settlement runs before the
    // family record is touched, so it owns the head of the trail.
    expect(ops.writeTrail().slice(0, 1 + fixture.purged.length)).toEqual([
      `put ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
      ...ids(fixture.purged).map((id) => `delete ${kvKeys.borrow(id)}`),
    ]);
    // …and nothing else in the whole request deletes a pointer.
    expect(ops.deleteKeys().filter((key) => key.startsWith("borrow:"))).toEqual(
      ids(fixture.purged).map(kvKeys.borrow),
    );
  });
});

// ===========================================================================
// Dissolve: the index goes with the family
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid — sole-owner dissolve", () => {
  it.each<{ shape: IndexShape }>([{ shape: "new" }, { shape: "legacy" }])(
    "deletes the index and every pointer it names ($shape shape)",
    async ({ shape }) => {
      // A one-member family whose index still holds records left by members who
      // are already gone — exactly the orphan the dissolve has to reclaim.
      await seedFamily();
      const records = [
        makeRecord(0, { status: BorrowStatus.RETURNED }),
        makeRecord(1, { status: BorrowStatus.LENT }),
      ];
      await seedIndex(records, shape);
      const aliceToken = await seedAuthToken(kv, ALICE);

      const ops = watchKvOps(kv);
      const res = await request(
        "DELETE",
        `/api/family/${FAMILY_ID}/member/${ALICE}`,
        undefined,
        aliceToken,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).data).toEqual({ ok: true });

      // The family really is dissolved — the cleanup is not standing in for it.
      expect(await kv.get(kvKeys.family(FAMILY_ID))).toBeNull();
      expect(await kv.get(kvKeys.member(ALICE))).toBeNull();

      // Index key gone, every pointer gone. LENT is NOT spared here: the family
      // that gave the loan its meaning no longer exists.
      expect(await kv.get(kvKeys.borrowsByFamily(FAMILY_ID))).toBeNull();
      expect(await livePointerKeys()).toEqual([]);

      // Pointers first, index key last — the inverse of the settlement's order,
      // deliberately: nothing is left pointing INTO an index being removed.
      expect(ops.writeTrail().slice(0, records.length + 1)).toEqual([
        ...ids(records).map((id) => `delete ${kvKeys.borrow(id)}`),
        `delete ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
      ]);

      // No fan-out: a legacy `string[]` index ALREADY is the id list, so the
      // dissolve must not spend a read per record to rediscover it.
      expect(ops.getKeys()).not.toContain(kvKeys.borrow(records[0].requestId));
    },
  );

  it("leaves an owner's dissolve alone when the family never borrowed", async () => {
    // Positive companion for the deletes above: with no index key there is
    // nothing to delete, and the dissolve still answers exactly the same.
    await seedFamily();
    const aliceToken = await seedAuthToken(kv, ALICE);

    const ops = watchKvOps(kv);
    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${ALICE}`,
      undefined,
      aliceToken,
    );

    expect(res.status).toBe(200);
    expect(ops.deleteKeys()).not.toContain(kvKeys.borrowsByFamily(FAMILY_ID));
    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBeNull();
  });
});

// ===========================================================================
// Account deletion takes the same two exits
// ===========================================================================

describe("DELETE /api/user/:id", () => {
  it("deletes the whole index when the departing account was the family's only member", async () => {
    await seedFamily();
    const records = [
      makeRecord(0, { status: BorrowStatus.RETURNED }),
      makeRecord(1, { status: BorrowStatus.LENT }),
    ];
    await seedIndex(records);
    const aliceToken = await seedAuthToken(kv, ALICE);

    const res = await request(
      "DELETE",
      `/api/user/${ALICE}`,
      undefined,
      aliceToken,
    );
    expect(res.status).toBe(200);

    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBeNull();
    expect(await kv.get(kvKeys.borrowsByFamily(FAMILY_ID))).toBeNull();
    expect(await livePointerKeys()).toEqual([]);
  });

  it("settles instead when the family has other members", async () => {
    await seedFamily([member(BOB, "Bob")]);
    const bobPending = makeRecord(0); // BOB borrows → cancelled, then purged
    const bobLent = makeRecord(1, { status: BorrowStatus.LENT }); // kept
    const aliceBorrows = makeRecord(2, {
      borrowerId: ALICE,
      borrowerName: "Alice",
      ownerId: BOB,
    }); // cancelled, but ALICE's record — kept
    await seedIndex([bobPending, bobLent, aliceBorrows]);
    const bobToken = await seedAuthToken(kv, BOB);

    const res = await request(
      "DELETE",
      `/api/user/${BOB}`,
      undefined,
      bobToken,
    );
    expect(res.status).toBe(200);

    // The family survives, minus BOB.
    const family = await kv.get<FamilyRecord>(kvKeys.family(FAMILY_ID), "json");
    expect(family?.members.map((m) => m.userId)).toEqual([ALICE]);

    const index = (await storedRecords()) ?? [];
    expect(ids(index)).toEqual(ids([bobLent, aliceBorrows]));
    expect(index[0].status).toBe(BorrowStatus.LENT);
    expect(index[1].status).toBe(BorrowStatus.CANCELLED);
    expect(await livePointerKeys()).toEqual(
      ids([bobLent, aliceBorrows]).map(kvKeys.borrow),
    );
  });
});

// ===========================================================================
// Fail-open: cleanup never turns a completed operation into an error
// ===========================================================================

describe("Departure cleanup when KV deletes reject", () => {
  it("still removes the member when an evicted pointer's delete rejects, and logs it", async () => {
    await seedFamily([member(BOB, "Bob")]);
    const purged = makeRecord(0, { status: BorrowStatus.RETURNED });
    const kept = makeRecord(1, { status: BorrowStatus.LENT });
    await seedIndex([purged, kept]);
    const aliceToken = await seedAuthToken(kv, ALICE);
    await seedAuthToken(kv, BOB);

    // Only the POINTER delete fails: the handler's own member / auth-token
    // deletes must still land, or the 200 below would prove something else.
    failDeletesMatching((key) => key === kvKeys.borrow(purged.requestId));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${BOB}`,
      undefined,
      aliceToken,
    );

    // NOT a 500 BORROW_CLEANUP_FAILED: the index write already landed, so
    // rejecting the caller would report a failure that did not happen.
    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.member(BOB))).toBeNull();

    // The record is out of the index either way; only its pointer is orphaned.
    expect(ids((await storedRecords()) ?? [])).toEqual([kept.requestId]);
    expect(await kv.get(kvKeys.borrow(purged.requestId))).not.toBeNull();

    // Swallowed, but never silent: the orphan key is named so it can be found.
    expect(errorSpy).toHaveBeenCalledWith(
      "BORROW_POINTER_DELETE_FAILED",
      expect.objectContaining({ requestId: purged.requestId }),
    );
  });

  it("still dissolves the family when the index key's own delete rejects, and logs it", async () => {
    await seedFamily();
    const record = makeRecord(0, { status: BorrowStatus.RETURNED });
    await seedIndex([record]);
    const aliceToken = await seedAuthToken(kv, ALICE);

    failDeletesMatching((key) => key === kvKeys.borrowsByFamily(FAMILY_ID));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${ALICE}`,
      undefined,
      aliceToken,
    );

    expect(res.status).toBe(200);
    // The dissolve the owner asked for happened; cleanup could not block it.
    expect(await kv.get(kvKeys.family(FAMILY_ID))).toBeNull();
    // Pointers are deleted first, so they went even though the index key stayed.
    expect(await livePointerKeys()).toEqual([]);
    expect(await kv.get(kvKeys.borrowsByFamily(FAMILY_ID))).not.toBeNull();

    expect(errorSpy).toHaveBeenCalledWith(
      "BORROW_INDEX_DELETE_FAILED",
      expect.objectContaining({ familyId: FAMILY_ID }),
    );
  });
});
