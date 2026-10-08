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
 *   by Cloudflare's native Rate Limiting binding (the `rateLimit` middleware): zero KV
 *   operations, so `ratelimit:{ip}:{minuteBucket}` is gone from both arrays.
 *   The binding call it was replaced by is pinned in `calls` below instead.
 * - Per-userId `borrow-update` counter — REMOVED by #160 item 1 for the same
 *   reason (`enforcePerUserRateLimit`); scope "borrow-update", ceiling 30 per 60s
 *   (routes/borrow.ts, `updateBorrowRoute`), which is what selects RATE_LIMIT_30_PER_MIN.
 *   It MUST stay keyed on the AUTHENTICATED caller, never on a body/path
 *   target id (security-ux Invariant 6): now that the KV key is gone, the
 *   `calls` assertion below is that rule's only automatic check.
 * - `token:{token}` — auth middleware (`authMiddleware`, middleware/auth.ts). Real cost.
 * - `borrow:{requestId}` — 1 get (routes/borrow.ts, `readBorrowPointer`)
 *   and NO put. Since #160 item 2 the key holds a `BorrowPointer`
 *   (`{ familyId }`); a bare requestId cannot name its family, so this read
 *   resolves which index owns the record. A status change cannot alter
 *   `familyId`, so the pointer is never rewritten — that is why `putKeys()`
 *   below no longer contains it.
 * - `family:{familyId}` — 1 get (routes/borrow.ts, `getFamilyRecord`),
 *   NO put. Added by issue #159: the caller must be a CURRENT member of the
 *   record's family, not merely a frozen party id, so a kicked / departed
 *   member holding a fresh token from a new family cannot flip an old LENT
 *   record to RETURNED. Read in `Promise.all` with the index (`readBorrowIndex`), so
 *   it costs one KV read but no extra round trip; the `Promise.all` argument
 *   order is what puts it BEFORE the index in `getKeys()` below.
 * - `borrows:family:{familyId}` — 1 get (`readBorrowIndex`) + 1 put (via
 *   `writeBorrowIndex`): the index IS the record, so the read-modify-write
 *   that used to happen on `borrow:{requestId}` happens here instead.
 * - `member:{callerId}` — 1 get (routes/borrow.ts, `isActiveMember`), NO
 *   put. Added by #222: "current member" now means ACTIVE — listed AND pointed
 *   at this family — because a kicked member re-listed by a stale full-record
 *   write is listed but pointerless. Read only when the family record exists
 *   (the orphan settle path reads nothing extra), and AFTER the parallel pair,
 *   which is why it is LAST in `getKeys()` below.
 *
 * THE +1 READ IS DELIBERATE, and it is #160 item 2's price. This handler
 * pays a pointer read and then an index read where it used to pay one,
 * because the record moved into the index. That is bought on purpose: `GET
 * /api/family/:id/borrow` went from O(index) reads to a constant
 * (tests/integration/budget/borrow-list-budget.test.ts), and listing is the
 * far hotter path — every client poll pays it, while a PATCH happens once per
 * human decision. Do NOT "optimise" this back by making the pointer carry the
 * record again: that is the fan-out, re-introduced one key at a time.
 *
 * THE SECOND +1 READ IS ALSO DELIBERATE — #159's price, the `family:{id}`
 * read above. It is an authorisation read, not a data read: dropping it
 * re-opens the kicked-member-settles-a-loan hole, so it must not be removed
 * to win the read back. tests/integration/borrowMembershipRecheck.test.ts is
 * the behaviour that this read pays for.
 *
 * THE THIRD +1 READ IS DELIBERATE TOO — #222's price, the `member:{callerId}`
 * read above. Same kind: authorisation. Dropping it lets a re-listed hollow
 * member settle a loan again (tests/integration/hollowMember.test.ts).
 *
 * THE RATE LIMITING BINDINGS ARE INJECTED, deliberately: every production
 * deploy carries all four (worker/wrangler.toml), and a request sent without
 * them falls back to the KV counters — which would re-pin numbers no deployed
 * Worker produces. See tests/helpers/rateLimitBindings.ts.
 *
 * NO DEV_MODE ON THE MEASURED REQUEST, deliberately: both rate-limit layers
 * short-circuit under it (`rateLimit`, `enforcePerUserRateLimit`) ahead of the binding lookup,
 * which would hide the fixed cost pinned in `calls`. See the scope caveat at
 * the end of tests/helpers/kvOps.ts.
 *
 * SEED: `seedPendingBorrow` writes one PENDING borrow record whose OWNER
 * (USER2) is the caller, so PENDING → LENT is an allowed transition, in the
 * CURRENT shape (#160 item 2): the record inside `borrows:family:{familyId}`,
 * a `{ familyId }` pointer at `borrow:{requestId}`.
 *
 * DELETES: a status transition removes nothing at this index size. It CAN
 * delete — `writeBorrowIndex` drops the pointers of terminal records evicted
 * past BORROW_HISTORY_KEEP, which tests/integration/borrowIndexMigration.test.ts
 * covers — but a 1-entry index is nowhere near the cap.
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
/** Fixed v4-shaped id (RequestIdSchema, src/schemas/common.ts). */
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const PATH = `/api/borrow/${REQUEST_ID}`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.4";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

let kv: KVNamespace;

/** One current-shape PENDING record owned by the caller (USER2); returns the owner's
 *  token. See the header → "SEED". */
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
  const pointer: BorrowPointer = { familyId: FAMILY_ID };
  await kv.put(kvKeys.borrow(REQUEST_ID), JSON.stringify(pointer));
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify([record]));

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
  it("performs exactly 5 KV reads and 1 KV write for a PENDING to LENT update", async () => {
    const token = await seedPendingBorrow();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(200);

    expect(ops.getKeys()).toEqual([
      // auth middleware, `authMiddleware`
      kvKeys.authToken(token),
      // handler, `readBorrowPointer` — the pointer, read for its `familyId` only
      kvKeys.borrow(REQUEST_ID),
      // handler, `getFamilyRecord` — the family record for the #159 re-check; FIRST of
      // the Promise.all pair, so a swap of the two arguments is a real change.
      kvKeys.family(FAMILY_ID),
      // handler, `readBorrowIndex` — the index that owns the record
      kvKeys.borrowsByFamily(FAMILY_ID),
      // handler, `isActiveMember` — the caller's (USER2's) pointer for the #222 re-check;
      // after the Promise.all pair because it needs the family record.
      kvKeys.member(USER2),
    ]);

    expect(ops.putKeys()).toEqual([
      // handler, `writeBorrowIndex` — the index with the updated record; the pointer
      // (only `familyId`, which a status change cannot alter) is NOT rewritten.
      kvKeys.borrowsByFamily(FAMILY_ID),
    ]);

    // Removes nothing: a 1-entry index is nowhere near the cap.
    // See the header → "DELETES".
    expect(ops.deleteKeys()).toEqual([]);

    // Two binding calls, zero KV ops; the second keyed on the AUTHENTICATED caller
    // (Inv-6) — USER2, not the `:requestId` param — its NAME encoding the ceiling.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
      {
        name: "RATE_LIMIT_30_PER_MIN",
        key: `ratelimit:user:borrow-update:${USER2}`,
      },
    ]);
  });
});
