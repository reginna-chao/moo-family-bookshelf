/**
 * KV operation budget — GET /api/family/{id}/borrow.
 *
 * WHAT THIS FILE IS (issue #162). It pins the EXACT number AND identity of the
 * KV reads/writes one borrow-list request performs TODAY, so any change to this
 * hot path's KV bill fails a test and has to be changed on purpose. It is a
 * tripwire, not a statement that the current bill is correct.
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
 * - Per-userId `borrow-list` counter — REMOVED by #160 item 1 for the same
 *   reason (rateLimit.ts:608); scope "borrow-list", ceiling 60 per 60s
 *   (routes/borrow.ts:411-416), which is what selects RATE_LIMIT_60_PER_MIN —
 *   the same binding the per-IP standard tier uses, kept apart by the KEY.
 *   It MUST stay keyed on the AUTHENTICATED caller, never on a body/path
 *   target id (security-ux Invariant 6): now that the KV key is gone, the
 *   `calls` assertion below is that rule's only automatic check.
 * - `borrow:{requestId}` — REMOVED by #160 item 2. The listing used to read one
 *   key PER INDEX ENTRY, so its cost grew linearly with the family's borrow
 *   history. `borrows:family:{familyId}` now carries the full records, so
 *   `readBorrowIndex` (routes/borrow.ts:442) answers the whole listing from the
 *   ONE index read and the fan-out is gone from `getKeys()` below. The seed
 *   holds a 2-entry index precisely so a returning fan-out would show up as two
 *   extra reads. The growth RATE has its own acceptance test in
 *   tests/integration/budget/borrow-index-growth.test.ts — which also pins the
 *   ONE case where the fan-out legitimately survives: a family still on the
 *   legacy `string[]` index, because migration is write-path only and a GET
 *   never writes.
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `family:{familyId}` (routes/borrow.ts:420, membership check) and
 *   `borrows:family:{familyId}` (:442) — real cost of the listing.
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
const CALLER_IP = "10.0.0.3";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

/** Fixed v4-shaped ids (RequestIdSchema, src/schemas/common.ts) in the index. */
const EXISTING_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/**
 * Two-member family + a 2-entry borrow index in the CURRENT shape (#160
 * item 2): the index holds the full records and each `borrow:{id}` holds only
 * a `{ familyId }` pointer. The caller (USER1) is a party to both records, so
 * the response is non-empty.
 *
 * The pointers are seeded even though a listing never reads them — they are
 * what a real create leaves behind, and their presence proves the 3 reads
 * below are the handler declining to touch them, not the fixture omitting
 * them. Returns the caller's token.
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
    bookId: `book-${i}`,
    bookTitle: `Book ${i}`,
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
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "cf-connecting-ip": CALLER_IP,
      },
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

describe("KV budget: GET /api/family/:id/borrow", () => {
  it("performs exactly 3 KV reads and no KV write for a 2-entry borrow index", async () => {
    const token = await seedFamilyWithBorrowIndex();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(200);
    // Non-empty response, from the index read alone: seed health, and what
    // stops the 3-read pin below from being satisfied by an empty listing.
    const body = (await res.json()) as Json;
    expect(body.data).toHaveLength(EXISTING_IDS.length);

    expect(ops.getKeys()).toEqual([
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // handler, borrow.ts:420 / :442
      kvKeys.family(FAMILY_ID),
      kvKeys.borrowsByFamily(FAMILY_ID),
      // No `borrow:{requestId}` entries: the index carries the records (#160
      // item 2). The seeded pointers exist and are deliberately NOT read.
    ]);

    // A read-only listing writes nothing at all now that both rate-limit
    // counters live on the platform.
    expect(ops.putKeys()).toEqual([]);
    expect(ops.deleteKeys()).toEqual([]);

    // The fixed per-request rate-limit cost, in the form it now takes: two
    // binding calls, zero KV operations. Both land on RATE_LIMIT_60_PER_MIN
    // because both ceilings are 60/min; only the KEY keeps them independent.
    // The second one carries the AUTHENTICATED caller's id (Invariant 6).
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
      {
        name: "RATE_LIMIT_60_PER_MIN",
        key: `ratelimit:user:borrow-list:${USER1}`,
      },
    ]);
  });
});
