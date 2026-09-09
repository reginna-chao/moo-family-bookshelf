/**
 * KV operation budget — PATCH /api/borrow/{requestId}.
 *
 * WHAT THIS FILE IS (issue #162). It pins the EXACT number AND identity of the
 * KV reads/writes one borrow-status update performs TODAY, so any change to
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
 * - Per-userId `borrow-update` counter — REMOVED by #160 item 1 for the same
 *   reason (rateLimit.ts:608); scope "borrow-update", ceiling 30 per 60s
 *   (routes/borrow.ts:455-460), which is what selects RATE_LIMIT_30_PER_MIN.
 *   It MUST stay keyed on the AUTHENTICATED caller, never on a body/path
 *   target id (security-ux Invariant 6): now that the KV key is gone, the
 *   `calls` assertion below is that rule's only automatic check.
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `borrow:{requestId}` — 1 get (routes/borrow.ts:464) + 1 put (:503): read
 *   the record, validate the transition, write it back. Real cost, and NOT
 *   part of #160 — this handler addresses a single record by id and does no
 *   index fan-out (unlike create / list). It is now the request's ONLY write.
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
  type BorrowRequest,
  type FamilyRecord,
} from "../../../src/kv/schema";
import { USER1, USER2 } from "../../helpers/ids";

const FAMILY_ID = "abcd-1234";
/** Fixed v4-shaped id (RequestIdSchema, src/schemas/common.ts). */
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const PATH = `/api/borrow/${REQUEST_ID}`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.4";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

let kv: KVNamespace;

/**
 * One PENDING borrow record whose OWNER (USER2) is the caller, so
 * PENDING → LENT is an allowed transition. Returns the owner's token.
 */
async function seedPendingBorrow(): Promise<string> {
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

  const record: BorrowRequest = {
    requestId: REQUEST_ID,
    familyId: FAMILY_ID,
    borrowerId: USER1,
    borrowerName: "Alice",
    ownerId: USER2,
    bookId: "book-1",
    bookTitle: "Book 1",
    bookAuthor: "Author",
    bookCoverUrl: "",
    status: BorrowStatus.PENDING,
    createdAt: new Date(PINNED_NOW).toISOString(),
    updatedAt: new Date(PINNED_NOW).toISOString(),
  };
  await kv.put(kvKeys.borrow(REQUEST_ID), JSON.stringify(record));
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify([REQUEST_ID]));

  return seedAuthToken(kv, USER2);
}

/** The measured request plus the binding calls it made. */
async function measuredRequest(token: string) {
  const { bindings, calls } = createRateLimitBindings();
  const res = await app.request(
    PATH,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "cf-connecting-ip": CALLER_IP,
      },
      body: JSON.stringify({ status: BorrowStatus.LENT }),
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

describe("KV budget: PATCH /api/borrow/:requestId", () => {
  it("performs exactly 2 KV reads and 1 KV write for a PENDING to LENT update", async () => {
    const token = await seedPendingBorrow();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(200);

    expect(ops.getKeys()).toEqual([
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // handler, borrow.ts:464 — the record being updated
      kvKeys.borrow(REQUEST_ID),
    ]);

    expect(ops.putKeys()).toEqual([
      // handler, borrow.ts:503 — the updated record. The family borrow index is
      // deliberately NOT rewritten: the record id it holds is unchanged.
      kvKeys.borrow(REQUEST_ID),
    ]);

    // A status transition removes nothing.
    expect(ops.deleteKeys()).toEqual([]);

    // The fixed per-request rate-limit cost, in the form it now takes: two
    // binding calls, zero KV operations. The second key carries the
    // AUTHENTICATED caller's id (Invariant 6) — USER2, the record's owner, not
    // the `:requestId` path param — and the binding NAME encodes the ceiling
    // routes/borrow.ts asked for.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
      {
        name: "RATE_LIMIT_30_PER_MIN",
        key: `ratelimit:user:borrow-update:${USER2}`,
      },
    ]);
  });
});
