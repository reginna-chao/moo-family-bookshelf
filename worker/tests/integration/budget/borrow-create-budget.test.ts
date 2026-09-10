/**
 * KV operation budget — POST /api/family/{id}/borrow.
 *
 * WHAT THIS FILE IS (issue #162). It pins the EXACT number AND identity of the
 * KV reads/writes one borrow-create request performs TODAY, so any change to
 * this hot path's KV bill fails a test and has to be changed on purpose. It is
 * a tripwire, not a statement that the current bill is correct.
 *
 * WHY THE ANNOTATION BELOW MATTERS. Several pinned entries ARE the waste that
 * issue #160 exists to remove. Without saying so here, a later implementer
 * reads a test-backed set of numbers as the right answer and preserves them —
 * the same mechanism by which the "known limitation" comment in
 * middleware/rateLimit.ts stopped reading as a debt note and started reading as
 * a permanent authorisation. #162 exists to stop that repeating.
 *
 * PER-KEY CLASSIFICATION
 * - Per-IP counter — REMOVED by #160 item 1. The standard tier is now counted
 *   by Cloudflare's native Rate Limiting binding (rateLimit.ts:427): zero KV
 *   operations, so `ratelimit:{ip}:{minuteBucket}` is gone from both arrays.
 *   The binding call it was replaced by is pinned in `calls` below instead.
 * - Per-userId `borrow-create` counter — REMOVED by #160 item 1 for the same
 *   reason (rateLimit.ts:608); scope "borrow-create", ceiling 10 per 60s
 *   (routes/borrow.ts:225-230), which is what selects RATE_LIMIT_10_PER_MIN.
 *   It MUST stay keyed on the AUTHENTICATED caller, never on a body/path
 *   target id (security-ux Invariant 6): now that the KV key is gone, the
 *   `calls` assertion below is that rule's only automatic check.
 * - `borrow:{existingRequestId}` — REMOVED by #160 item 2. The duplicate check
 *   used to read one key PER INDEX ENTRY, so its cost grew with the family's
 *   borrow history. `borrows:family:{familyId}` now carries the full records
 *   (services/borrowIndex.ts `readBorrowIndex`), so `readBorrowIndex` at
 *   routes/borrow.ts:290 answers the check with the ONE index read that was
 *   already being paid for, and the fan-out is gone from `getKeys()` below.
 *   Do not re-introduce it: the seed here holds a 2-entry index precisely so a
 *   returning fan-out would show up as two extra reads. That single read now
 *   also answers the per-borrower PENDING ceiling
 *   (`BORROW_MAX_PENDING_PER_BORROWER`, routes/borrow.ts:318-329) — a second
 *   bound added on top of it, at no extra KV cost.
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `family:{familyId}` (routes/borrow.ts:234) and
 *   `borrows:family:{familyId}` (get :290, put :388 via `writeBorrowIndex`) —
 *   real cost of creating the request.
 * - `borrow:{newRequestId}` (put :386) — the new `BorrowPointer`
 *   (`{ familyId }`, kv/schema.ts), whose only reader is
 *   `PATCH /api/borrow/:requestId`. It is written FIRST, deliberately, because
 *   the two half-failures are NOT symmetric — see the create handler's
 *   rationale (routes/borrow.ts:372-384). That ordering is pinned by
 *   `writeTrail()` below, which `putKeys()` alone could not see.
 *
 * THE RATE LIMITING BINDINGS ARE INJECTED, deliberately: every production
 * deploy carries all four (worker/wrangler.toml), and a request sent without
 * them falls back to the KV counters — which would re-pin numbers no deployed
 * Worker produces. See tests/helpers/rateLimitBindings.ts.
 *
 * NO DEV_MODE ON THE MEASURED REQUEST, deliberately: both rate-limit layers
 * short-circuit under it (rateLimit.ts:415, :601) ahead of the binding lookup,
 * which would hide the fixed cost pinned in `calls`. See the scope caveat at
 * the end of tests/helpers/kvOps.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../../src/index";
import { createMockKV } from "../../helpers/mockKv";
import { watchKvOps } from "../../helpers/kvOps";
import { createRateLimitBindings } from "../../helpers/rateLimitBindings";
import { seedAuthToken } from "../../helpers/auth";
import {
  BoolFlag,
  BorrowStatus,
  kvKeys,
  type BorrowPointer,
  type BorrowRequest,
  type FamilyRecord,
} from "../../../src/kv/schema";
import { USER1, USER2 } from "../../helpers/ids";

const FAMILY_ID = "abcd-1234";
const PATH = `/api/family/${FAMILY_ID}/borrow`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.2";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

/** Fixed v4-shaped ids (RequestIdSchema, src/schemas/common.ts) already indexed. */
const EXISTING_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
/** The borrowed book — distinct from the seeded ones, so no DUPLICATE_REQUEST. */
const NEW_BOOK_ID = "book-new";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/**
 * Two-member lending family + a 2-entry borrow index in the CURRENT shape
 * (#160 item 2): the index holds the full records and each `borrow:{id}` holds
 * only a `{ familyId }` pointer. Returns the caller's token.
 *
 * Seeding the legacy `string[]` index instead would make the handler fan out
 * one last time and re-pin numbers no migrated family produces — the legacy
 * read path has its own coverage in
 * tests/integration/budget/borrow-index-growth.test.ts and
 * tests/integration/borrowIndexMigration.test.ts.
 */
async function seedFamilyWithBorrowIndex(): Promise<string> {
  const family: FamilyRecord = {
    familyId: FAMILY_ID,
    ownerId: USER1,
    members: [
      { userId: USER1, displayName: "Alice", canLend: BoolFlag.TRUE },
      { userId: USER2, displayName: "Bob", canLend: BoolFlag.TRUE },
    ],
    maxMembers: 2,
    createdAt: new Date(PINNED_NOW).toISOString(),
  };
  await kv.put(kvKeys.family(FAMILY_ID), JSON.stringify(family));
  await kv.put(kvKeys.member(USER1), FAMILY_ID);
  await kv.put(kvKeys.member(USER2), FAMILY_ID);

  const records: BorrowRequest[] = EXISTING_IDS.map((requestId, i) => ({
    requestId,
    familyId: FAMILY_ID,
    borrowerId: USER1,
    borrowerName: "Alice",
    ownerId: USER2,
    bookId: `book-existing-${i}`,
    bookTitle: `Existing ${i}`,
    bookAuthor: "Author",
    bookCoverUrl: "",
    status: BorrowStatus.PENDING,
    createdAt: new Date(PINNED_NOW).toISOString(),
    updatedAt: new Date(PINNED_NOW).toISOString(),
  }));
  for (const requestId of EXISTING_IDS) {
    const pointer: BorrowPointer = { familyId: FAMILY_ID };
    await kv.put(kvKeys.borrow(requestId), JSON.stringify(pointer));
  }
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(records));

  return seedAuthToken(kv, USER1);
}

/** The measured request plus the binding calls it made. */
async function measuredRequest(token: string) {
  const { bindings, calls } = createRateLimitBindings();
  const res = await app.request(
    PATH,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "cf-connecting-ip": CALLER_IP,
      },
      body: JSON.stringify({
        bookId: NEW_BOOK_ID,
        bookTitle: "New Book",
        bookAuthor: "Author",
        ownerId: USER2,
      }),
    },
    { KV: kv, ...bindings },
  );
  return { res, calls };
}

beforeEach(() => {
  kv = createMockKV();
  // Pin Date so the seeded timestamps are deterministic.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("KV budget: POST /api/family/:id/borrow", () => {
  it("performs exactly 3 KV reads and 2 KV writes against a 2-entry borrow index", async () => {
    const token = await seedFamilyWithBorrowIndex();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(201);
    // The new record's id is server-generated (crypto.randomUUID, borrow.ts:332),
    // so it is read back from the response and pinned exactly like the rest.
    const created = (await res.json()) as Json;
    const newRequestId = created.data.requestId as string;

    expect(ops.getKeys()).toEqual([
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // handler, borrow.ts:234 / :290
      kvKeys.family(FAMILY_ID),
      kvKeys.borrowsByFamily(FAMILY_ID),
      // No `borrow:{existingRequestId}` entries: the index carries the records
      // the DUPLICATE_REQUEST check needs (#160 item 2). Two of them would be
      // here if the fan-out came back — the seed holds a 2-entry index.
    ]);

    // ORDER IS THE POINT, so this is `writeTrail` rather than `putKeys`: the
    // POINTER goes first — see the create handler's rationale
    // (routes/borrow.ts:372-384). The two half-failures are not symmetric. An
    // index entry with no pointer is a PENDING ghost: both parties see it,
    // PATCH cannot resolve its family so nobody can approve / reject / cancel
    // it, PENDING is never trimmed so it stays forever, and DUPLICATE_REQUEST
    // then blocks re-requesting that book permanently. A pointer with no index
    // entry is invisible to every reader, answers the same 404 an unknown id
    // does, and the caller's retry produces a clean record. So the recoverable
    // half is written first. borrow.ts:386 then :388.
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.borrow(newRequestId)}`,
      `put ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
    ]);

    // Creating a request removes nothing. (A create CAN delete — writeBorrowIndex
    // drops evicted pointers past BORROW_HISTORY_KEEP — but this 2-entry,
    // all-PENDING index is nowhere near the cap.)
    expect(ops.deleteKeys()).toEqual([]);

    // The fixed per-request rate-limit cost, in the form it now takes: two
    // binding calls, zero KV operations. The second key carries the
    // AUTHENTICATED caller's id (Invariant 6), and the binding NAME encodes the
    // ceiling routes/borrow.ts asked for.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
      {
        name: "RATE_LIMIT_10_PER_MIN",
        key: `ratelimit:user:borrow-create:${USER1}`,
      },
    ]);
  });
});
