/**
 * Borrow index migration, history cap and the two bounds that guard the shared
 * index value, end to end through the HTTP handlers.
 *
 * Since #160 item 2 `borrows:family:{familyId}` holds the full
 * `BorrowRequest[]` and `borrow:{requestId}` is only a `{ familyId }` pointer.
 * Families created before that change still carry the LEGACY shape (a
 * `string[]` index plus full records), and migration is deliberately LAZY and
 * WRITE-PATH ONLY: create, PATCH, and the departure settlement
 * (`settleDepartingBorrower`) rewrite the index; `GET /api/family/:id/borrow`
 * serves both shapes and never writes. The departure path's own behaviour —
 * cancel, purge, dissolve, fail-open — lives in
 * tests/integration/borrowDeparture.test.ts; what the two cases at the end of
 * THIS file pin is only its effect on the stored index SHAPE.
 *
 * These cases pin the boundary that design creates, at the level a client
 * actually experiences it:
 * - what a legacy family sees before and after its first write;
 * - what the history cap does to old TERMINAL records
 *   (`BORROW_HISTORY_KEEP`, evicted on write);
 * - what the create boundary does once one borrower's PENDING records — which
 *   the history cap deliberately never evicts — reach
 *   `BORROW_MAX_PENDING_PER_BORROWER`;
 * - what PATCH does when the pointer and the record disagree about which
 *   family owns the request.
 *
 * The pure functions behind all of it are covered in
 * tests/unit/borrowIndex.test.ts; the KV op COUNTS live in
 * tests/integration/budget/.
 *
 * DEV_MODE is on for every request here: rate limiting is not what these cases
 * are about, and its counters would add writes to the `watchKvOps` assertions
 * (see the scope caveat at the end of tests/helpers/kvOps.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import {
  BoolFlag,
  BORROW_HISTORY_KEEP,
  BORROW_MAX_PENDING_PER_BORROWER,
  BorrowStatus,
  kvKeys,
  type BorrowPointer,
  type BorrowRequest,
  type FamilyRecord,
} from "../../src/kv/schema";
import { ALICE, BOB } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const FAMILY_ID = "abcd-1234";
/**
 * A DIFFERENT, equally well-formed familyId. Used where a record has to claim
 * a family other than the one whose index holds it: the point is the
 * DISAGREEMENT, so the value must not also be malformed, or the pointer's own
 * format guard would be what refused the request.
 */
const OTHER_FAMILY_ID = "wxyz-9876";
const BASE_MS = Date.parse("2026-03-01T12:00:00.000Z");

const VALID_COVER_URL = "https://cdn.readmoo.com/cover/cover.jpg";

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

/** BOB borrows ALICE's book; timestamps grow with `index` so "oldest" is index 0. */
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
    bookCoverUrl: VALID_COVER_URL,
    status: BorrowStatus.PENDING,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** ALICE (owner) + BOB, both lending-enabled. */
async function seedFamily(): Promise<void> {
  const family: FamilyRecord = {
    familyId: FAMILY_ID,
    ownerId: ALICE,
    members: [
      { userId: ALICE, displayName: "Alice", canLend: BoolFlag.TRUE },
      { userId: BOB, displayName: "Bob", canLend: BoolFlag.TRUE },
    ],
    maxMembers: 2,
    createdAt: new Date(BASE_MS).toISOString(),
  };
  await kv.put(kvKeys.family(FAMILY_ID), JSON.stringify(family));
  await kv.put(kvKeys.member(ALICE), FAMILY_ID);
  await kv.put(kvKeys.member(BOB), FAMILY_ID);
}

/** Pre-migration storage: `string[]` index + a FULL record per `borrow:{id}`. */
async function seedLegacyIndex(records: BorrowRequest[]): Promise<void> {
  for (const record of records) {
    await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(record));
  }
  await kv.put(
    kvKeys.borrowsByFamily(FAMILY_ID),
    JSON.stringify(records.map((r) => r.requestId)),
  );
}

/** Current storage: records in the index + a `{ familyId }` pointer per record. */
async function seedNewIndex(records: BorrowRequest[]): Promise<void> {
  for (const record of records) {
    const pointer: BorrowPointer = { familyId: FAMILY_ID };
    await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(pointer));
  }
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(records));
}

/** The raw stored index, unparsed — so its SHAPE can be asserted. */
async function storedIndex(): Promise<unknown> {
  return await kv.get(kvKeys.borrowsByFamily(FAMILY_ID), "json");
}

const ids = (records: BorrowRequest[]): string[] =>
  records.map((r) => r.requestId);

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// A legacy family keeps working, and a GET never migrates it
// ===========================================================================

describe("GET /api/family/:id/borrow on an un-migrated family", () => {
  it("returns the same records as a migrated family and writes nothing", async () => {
    await seedFamily();
    const records = [
      makeRecord(0),
      makeRecord(1, { status: BorrowStatus.LENT }),
    ];
    await seedLegacyIndex(records);
    const token = await seedAuthToken(kv, ALICE);

    const ops = watchKvOps(kv);
    const res = await request(
      "GET",
      `/api/family/${FAMILY_ID}/borrow`,
      undefined,
      token,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data).toEqual(records);

    // Migration is write-path only: a listing must not turn a reader into a
    // writer. `writeTrail` covers puts AND deletes.
    expect(ops.writeTrail()).toEqual([]);
    // …and the index is still legacy afterwards — the positive companion that
    // stops the assertion above from passing on an already-migrated fixture.
    expect(await storedIndex()).toEqual(ids(records));
  });
});

// ===========================================================================
// The first WRITE migrates — and leaves the legacy records alone
// ===========================================================================

describe("PATCH /api/borrow/:requestId on an un-migrated family", () => {
  it("migrates the index and leaves the legacy borrow record byte-identical", async () => {
    await seedFamily();
    const records = [makeRecord(0), makeRecord(1)];
    await seedLegacyIndex(records);
    const token = await seedAuthToken(kv, ALICE);

    const legacyBefore = await kv.get(kvKeys.borrow(records[0].requestId));

    const res = await request(
      "PATCH",
      `/api/borrow/${records[0].requestId}`,
      { status: BorrowStatus.LENT },
      token,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.status).toBe(BorrowStatus.LENT);

    // The index is now the new shape and carries the updated record.
    const index = (await storedIndex()) as BorrowRequest[];
    expect(index.map((r) => r.requestId)).toEqual(ids(records));
    expect(index[0].status).toBe(BorrowStatus.LENT);
    expect(index[1].status).toBe(BorrowStatus.PENDING);

    // The legacy `borrow:{id}` value is NOT rewritten — it is a stale copy no
    // reader consults; only its existence still matters, as the pointer. Its
    // stale status is exactly what proves the index is now the truth.
    expect(await kv.get(kvKeys.borrow(records[0].requestId))).toBe(
      legacyBefore,
    );
    const stale = (await kv.get<BorrowRequest>(
      kvKeys.borrow(records[0].requestId),
      "json",
    )) as BorrowRequest;
    expect(stale.status).toBe(BorrowStatus.PENDING);
  });
});

// ===========================================================================
// A pointer without an index entry is "no such request"
// ===========================================================================

describe("PATCH /api/borrow/:requestId when the index entry is gone", () => {
  it("returns 404 REQUEST_NOT_FOUND for a pointer whose record was trimmed", async () => {
    await seedFamily();
    const survivor = makeRecord(1);
    await seedNewIndex([survivor]);

    // An orphan pointer: the record aged out of the history cap (or a delete
    // failed after the trim), so the pointer resolves but the index has no
    // entry. Same 404 as an unknown requestId — the response must not disclose
    // that the id ever existed.
    const trimmed = makeRecord(0);
    const pointer: BorrowPointer = { familyId: FAMILY_ID };
    await kv.put(kvKeys.borrow(trimmed.requestId), JSON.stringify(pointer));

    const token = await seedAuthToken(kv, ALICE);
    const res = await request(
      "PATCH",
      `/api/borrow/${trimmed.requestId}`,
      { status: BorrowStatus.LENT },
      token,
    );

    expect(res.status).toBe(404);
    const body = await res.text();
    expect((JSON.parse(body) as Json).error.code).toBe("REQUEST_NOT_FOUND");

    // Byte-identical to the unknown-id answer: no extra disclosure.
    const unknown = await request(
      "PATCH",
      `/api/borrow/${requestIdAt(999)}`,
      { status: BorrowStatus.LENT },
      token,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(body);
  });
});

// ===========================================================================
// The history cap evicts on the write that exceeds it
// ===========================================================================

describe("PATCH /api/borrow/:requestId at the history cap", () => {
  it("evicts the oldest terminal record and deletes its pointer, still answering 200", async () => {
    await seedFamily();
    const terminal = Array.from({ length: BORROW_HISTORY_KEEP }, (_, i) =>
      makeRecord(i, { status: BorrowStatus.RETURNED }),
    );
    const pending = makeRecord(500);
    await seedNewIndex([...terminal, pending]);
    const token = await seedAuthToken(kv, ALICE);

    const ops = watchKvOps(kv);
    // ALICE owns the book, so PENDING → REJECTED is hers to make. It pushes the
    // terminal count to BORROW_HISTORY_KEEP + 1.
    const res = await request(
      "PATCH",
      `/api/borrow/${pending.requestId}`,
      { status: BorrowStatus.REJECTED },
      token,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data).toMatchObject({
      requestId: pending.requestId,
      status: BorrowStatus.REJECTED,
    });

    // Exactly one eviction, and it is the OLDEST by updatedAt. The record just
    // updated carries the newest timestamp, so it is never the one evicted.
    expect(ops.deleteKeys()).toEqual([kvKeys.borrow(terminal[0].requestId)]);
    expect(await kv.get(kvKeys.borrow(terminal[0].requestId))).toBeNull();

    const index = (await storedIndex()) as BorrowRequest[];
    expect(index).toHaveLength(BORROW_HISTORY_KEEP);
    expect(index.map((r) => r.requestId)).toEqual([
      ...ids(terminal.slice(1)),
      pending.requestId,
    ]);
  });
});

// ===========================================================================
// The pointer and the record must agree on which family owns the request
// ===========================================================================

describe("PATCH /api/borrow/:requestId when pointer and record disagree", () => {
  it("returns 404 REQUEST_NOT_FOUND and writes nothing", async () => {
    await seedFamily();
    // The pointer says FAMILY_ID (that is where `seedNewIndex` writes it), but
    // the record sitting in FAMILY_ID's index claims a different family. One of
    // the two is corrupt; acting on it would rewrite THIS family's whole index
    // from a record that says it belongs elsewhere.
    const mismatched = makeRecord(0, { familyId: OTHER_FAMILY_ID });
    await seedNewIndex([mismatched]);
    const token = await seedAuthToken(kv, ALICE);

    const ops = watchKvOps(kv);
    const res = await request(
      "PATCH",
      `/api/borrow/${mismatched.requestId}`,
      { status: BorrowStatus.LENT },
      token,
    );

    expect(res.status).toBe(404);
    const body = await res.text();
    expect((JSON.parse(body) as Json).error.code).toBe("REQUEST_NOT_FOUND");

    // Refused BEFORE any write: the index is left exactly as it was.
    expect(ops.putKeys()).toEqual([]);
    expect(ops.writeTrail()).toEqual([]);
    expect(await storedIndex()).toEqual([mismatched]);

    // Byte-identical to the unknown-id answer: the refusal discloses nothing
    // about the request having existed.
    const unknown = await request(
      "PATCH",
      `/api/borrow/${requestIdAt(999)}`,
      { status: BorrowStatus.LENT },
      token,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(body);
  });

  it("still updates a record whose familyId matches its pointer", async () => {
    // Positive companion: without it, a handler that 404'd every PATCH would
    // keep the case above green.
    await seedFamily();
    const matching = makeRecord(0, { familyId: FAMILY_ID });
    await seedNewIndex([matching]);
    const token = await seedAuthToken(kv, ALICE);

    const res = await request(
      "PATCH",
      `/api/borrow/${matching.requestId}`,
      { status: BorrowStatus.LENT },
      token,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data.status).toBe(BorrowStatus.LENT);
  });
});

// ===========================================================================
// The per-borrower PENDING ceiling at the create boundary
// ===========================================================================
//
// PENDING records are exempt from the history cap — evicting one would strand
// a request the owner still has to answer — so they are the one part of the
// index a single member could otherwise grow without bound. The ceiling counts
// the CALLER's own PENDING records only (Inv-6: nobody else's traffic can
// spend a member's allowance), and it is checked AFTER membership and
// DUPLICATE_REQUEST, off the index read those already paid for.

/** `count` PENDING records, each for a distinct book, borrowed by `borrowerId`. */
function makePendingRun(count: number, borrowerId: string): BorrowRequest[] {
  const borrowsFromAlice = borrowerId === BOB;
  return Array.from({ length: count }, (_, i) =>
    makeRecord(i, {
      borrowerId,
      borrowerName: borrowsFromAlice ? "Bob" : "Alice",
      ownerId: borrowsFromAlice ? ALICE : BOB,
    }),
  );
}

/** BOB asks to borrow one more of ALICE's books. */
function borrowNewBookAsBob(token: string) {
  return request(
    "POST",
    `/api/family/${FAMILY_ID}/borrow`,
    {
      bookId: "book-new",
      bookTitle: "New Book",
      bookAuthor: "Author",
      bookCoverUrl: VALID_COVER_URL,
      ownerId: ALICE,
    },
    token,
  );
}

describe("POST /api/family/:id/borrow at the per-borrower PENDING ceiling", () => {
  it("admits the request that fills the ceiling", async () => {
    await seedFamily();
    await seedNewIndex(
      makePendingRun(BORROW_MAX_PENDING_PER_BORROWER - 1, BOB),
    );
    const token = await seedAuthToken(kv, BOB);

    const res = await borrowNewBookAsBob(token);

    // The boundary is ">= cap", so the request that brings the count TO the cap
    // must still succeed. Without this case an off-by-one that refused at
    // cap - 1 would keep the refusal case below green.
    expect(res.status).toBe(201);
    expect((await storedIndex()) as BorrowRequest[]).toHaveLength(
      BORROW_MAX_PENDING_PER_BORROWER,
    );
  });

  it("refuses the next one with 409 TOO_MANY_PENDING_REQUESTS and writes nothing", async () => {
    await seedFamily();
    const pending = makePendingRun(BORROW_MAX_PENDING_PER_BORROWER, BOB);
    await seedNewIndex(pending);
    const token = await seedAuthToken(kv, BOB);

    const ops = watchKvOps(kv);
    const res = await borrowNewBookAsBob(token);

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe(
      "TOO_MANY_PENDING_REQUESTS",
    );

    // No index entry and no pointer: the refusal costs the family nothing, and
    // `writeTrail` covers deletes as well as puts.
    expect(ops.putKeys()).toEqual([]);
    expect(ops.writeTrail()).toEqual([]);
    expect(await storedIndex()).toEqual(pending);
  });

  it("counts only the CALLER's own records, not the whole family's", async () => {
    await seedFamily();
    // The ceiling is spent by ALICE, borrowing BOB's books. If it were keyed on
    // the family (or on the target), BOB's own first request would be refused
    // by someone else's traffic — the Inv-6 failure mode.
    await seedNewIndex(makePendingRun(BORROW_MAX_PENDING_PER_BORROWER, ALICE));
    const token = await seedAuthToken(kv, BOB);

    const res = await borrowNewBookAsBob(token);

    expect(res.status).toBe(201);
  });

  it("counts only PENDING records, not finished ones", async () => {
    await seedFamily();
    // A borrower who has FINISHED this many borrows is not holding anything
    // open, so nothing is blocked. These are terminal, but exactly AT the
    // history cap, so the create's own write evicts none of them either.
    const finished = makePendingRun(BORROW_MAX_PENDING_PER_BORROWER, BOB).map(
      (r) => ({ ...r, status: BorrowStatus.RETURNED }),
    );
    await seedNewIndex(finished);
    const token = await seedAuthToken(kv, BOB);

    const res = await borrowNewBookAsBob(token);

    expect(res.status).toBe(201);
    expect((await storedIndex()) as BorrowRequest[]).toHaveLength(
      BORROW_MAX_PENDING_PER_BORROWER + 1,
    );
  });
});

// ===========================================================================
// The duplicate check reads the index, not a fan-out
// ===========================================================================

describe("POST /api/family/:id/borrow duplicate check against the new index", () => {
  it("refuses a second request for a PENDING book but allows one for a RETURNED book", async () => {
    await seedFamily();
    const pending = makeRecord(0, { bookId: "book-pending" });
    const returned = makeRecord(1, {
      bookId: "book-returned",
      status: BorrowStatus.RETURNED,
    });
    await seedNewIndex([pending, returned]);
    const token = await seedAuthToken(kv, BOB);

    const body = {
      bookTitle: "Test Book",
      bookAuthor: "Test Author",
      bookCoverUrl: VALID_COVER_URL,
      ownerId: ALICE,
    };

    const duplicate = await request(
      "POST",
      `/api/family/${FAMILY_ID}/borrow`,
      { ...body, bookId: "book-pending" },
      token,
    );
    expect(duplicate.status).toBe(400);
    expect(((await duplicate.json()) as Json).error.code).toBe(
      "DUPLICATE_REQUEST",
    );

    // A finished transaction is not a duplicate — the same book can be
    // borrowed again. This is the positive companion: without it, a check that
    // refused everything would keep the case above green.
    const reborrow = await request(
      "POST",
      `/api/family/${FAMILY_ID}/borrow`,
      { ...body, bookId: "book-returned" },
      token,
    );
    expect(reborrow.status).toBe(201);

    const index = (await storedIndex()) as BorrowRequest[];
    expect(index).toHaveLength(3);
  });
});

// ===========================================================================
// Member removal migrates only when the settlement actually changes something
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid on an un-migrated family", () => {
  it("migrates the index, purging the departing member's own record and keeping the rest", async () => {
    await seedFamily();
    // BOB borrows ALICE's book → cancelled by the departure, and then purged in
    // the same settlement: it is BOB's own finished history.
    const pending = makeRecord(0);
    // BOB borrows ALICE's book, already out on loan → untouched.
    const lent = makeRecord(1, { status: BorrowStatus.LENT });
    // ALICE borrows BOB's book → cancelled, but KEPT: it is ALICE's history and
    // purging by ownerId would let a leaver delete a remaining member's records.
    const ownerSide = makeRecord(2, {
      borrowerId: ALICE,
      borrowerName: "Alice",
      ownerId: BOB,
    });
    await seedLegacyIndex([pending, lent, ownerSide]);
    const aliceToken = await seedAuthToken(kv, ALICE);
    await seedAuthToken(kv, BOB);

    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(res.status).toBe(200);

    const index = (await storedIndex()) as BorrowRequest[];
    expect(index.map((r) => r.requestId)).toEqual(ids([lent, ownerSide]));
    // LENT is left alone: the book may still physically be out.
    expect(index[0].status).toBe(BorrowStatus.LENT);
    // The CANCELLATION half of the settlement, still pinned — observable on the
    // record the departing member merely OWNED, since the one they borrowed is
    // purged before any reader could see its status.
    expect(index[1].status).toBe(BorrowStatus.CANCELLED);

    // The PURGE half: index entry gone AND pointer deleted.
    expect(await kv.get(kvKeys.borrow(pending.requestId))).toBeNull();
    // Positive companion: the survivors keep their legacy `borrow:{id}` values,
    // which are NOT rewritten — only their existence still matters, as pointers.
    expect(await kv.get(kvKeys.borrow(lent.requestId))).not.toBeNull();
    expect(await kv.get(kvKeys.borrow(ownerSide.requestId))).not.toBeNull();
  });

  it("leaves the index legacy when the departing member's records need no change", async () => {
    await seedFamily();
    // ALICE borrowed BOB's book and already returned it. BOB is leaving, but he
    // is only the OWNER here: nothing to cancel (the record is terminal) and
    // nothing to purge (it is ALICE's own history). So the settlement has no
    // work, and an un-migrated family must not be rewritten for no reason.
    const returned = makeRecord(0, {
      borrowerId: ALICE,
      borrowerName: "Alice",
      ownerId: BOB,
      status: BorrowStatus.RETURNED,
    });
    await seedLegacyIndex([returned]);
    const aliceToken = await seedAuthToken(kv, ALICE);
    await seedAuthToken(kv, BOB);

    const ops = watchKvOps(kv);
    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(res.status).toBe(200);

    expect(ops.putKeys()).not.toContain(kvKeys.borrowsByFamily(FAMILY_ID));
    expect(ops.deleteKeys()).not.toContain(kvKeys.borrow(returned.requestId));
    // Positive companion for those negative assertions — the removal really did
    // write, so the key names above are not typos that can never match.
    expect(ops.putKeys()).toContain(kvKeys.family(FAMILY_ID));

    expect(await storedIndex()).toEqual([returned.requestId]);
    expect(await kv.get(kvKeys.borrow(returned.requestId))).not.toBeNull();
  });

  it("rewrites the index when the departing member's own finished record is purged", async () => {
    // Companion to the case above: flip ONE field — who BORROWED — and the same
    // removal now has work to do. Without it, "legacy stays legacy" could stay
    // green on a handler that had stopped writing the index at all.
    await seedFamily();
    const returned = makeRecord(0, { status: BorrowStatus.RETURNED });
    await seedLegacyIndex([returned]);
    const aliceToken = await seedAuthToken(kv, ALICE);
    await seedAuthToken(kv, BOB);

    const ops = watchKvOps(kv);
    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${BOB}`,
      undefined,
      aliceToken,
    );
    expect(res.status).toBe(200);

    expect(ops.putKeys()).toContain(kvKeys.borrowsByFamily(FAMILY_ID));
    // Migrated AND emptied: the leaver's only record was their own history.
    expect(await storedIndex()).toEqual([]);
    expect(await kv.get(kvKeys.borrow(returned.requestId))).toBeNull();
  });
});
