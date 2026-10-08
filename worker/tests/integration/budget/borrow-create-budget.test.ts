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
 *   by Cloudflare's native Rate Limiting binding (the `rateLimit` middleware): zero KV
 *   operations, so `ratelimit:{ip}:{minuteBucket}` is gone from both arrays.
 *   The binding call it was replaced by is pinned in `calls` below instead.
 * - Per-userId `borrow-create` counter — REMOVED by #160 item 1 for the same
 *   reason (`enforcePerUserRateLimit`); scope "borrow-create", ceiling 10 per 60s
 *   (routes/borrow.ts, `createBorrowRoute`), which is what selects RATE_LIMIT_10_PER_MIN.
 *   It MUST stay keyed on the AUTHENTICATED caller, never on a body/path
 *   target id (security-ux Invariant 6): now that the KV key is gone, the
 *   `calls` assertion below is that rule's only automatic check.
 * - `borrow:{existingRequestId}` — REMOVED by #160 item 2. The duplicate check
 *   used to read one key PER INDEX ENTRY, so its cost grew with the family's
 *   borrow history. `borrows:family:{familyId}` now carries the full records
 *   (services/borrowIndex.ts `readBorrowIndex`), so `readBorrowIndex` at
 *   routes/borrow.ts (`createBorrowRoute`) answers the check with the ONE index read that was
 *   already being paid for, and the fan-out is gone from `getKeys()` below.
 *   Do not re-introduce it: the seed here holds a 2-entry index precisely so a
 *   returning fan-out would show up as two extra reads. That single read now
 *   also answers the per-borrower PENDING ceiling
 *   (`BORROW_MAX_PENDING_PER_BORROWER`, routes/borrow.ts) — a second
 *   bound added on top of it, at no extra KV cost.
 * - `token:{token}` — auth middleware (`authMiddleware`, middleware/auth.ts). Real cost.
 * - `family:{familyId}` (routes/borrow.ts, `getFamilyRecord`) and
 *   `borrows:family:{familyId}` (get `readBorrowIndex`, put `writeBorrowIndex`) —
 *   real cost of creating the request.
 * - `member:{callerId}` and `member:{ownerId}` (routes/borrow.ts,
 *   `isActiveMember` in `Promise.all`) — added by #222. AUTHORISATION reads,
 *   not waste: both parties must be ACTIVE members (listed AND pointed at this
 *   family), because a kicked member re-listed by a stale full-record write is
 *   listed but pointerless and must neither borrow nor be borrowed from.
 *   Dropping either re-opens that hole (tests/integration/hollowMember.test.ts).
 *   Parallel, so two reads but one round trip; the argument order (caller
 *   first) is what fixes their order in `getKeys()` below. The owner read is
 *   skipped when `ownerId === callerId` — that request is refused either way.
 * - `borrow:{newRequestId}` (put `writeBorrowPointer`) — the new `BorrowPointer`
 *   (`{ familyId }`, kv/schema.ts), whose only reader is
 *   `PATCH /api/borrow/:requestId`. It is written FIRST, deliberately, because
 *   the two half-failures are NOT symmetric — see the create handler's
 *   rationale (above `writeBorrowPointer` in routes/borrow.ts). That ordering is pinned by
 *   `writeTrail()` below, which `putKeys()` alone could not see.
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
 * SEED: `seedFamilyWithBorrowIndex` builds a two-member lending family + a
 * 2-entry borrow index in the CURRENT shape (#160 item 2): the index holds the
 * full records and each `borrow:{id}` holds only a `{ familyId }` pointer.
 * Seeding the legacy `string[]` index instead would make the handler fan out
 * one last time and re-pin numbers no migrated family produces — the legacy
 * read path has its own coverage in
 * tests/integration/budget/borrow-index-growth.test.ts and
 * tests/integration/borrowIndexMigration.test.ts.
 *
 * WRITE ORDER (`writeTrail`, not `putKeys`, because ORDER IS THE POINT): the
 * POINTER goes first — see the create handler's rationale
 * (above `writeBorrowPointer` in routes/borrow.ts), `writeBorrowPointer` then
 * `writeBorrowIndex`. The two half-failures
 * are not symmetric. An index entry with no pointer is a PENDING ghost: both
 * parties see it, PATCH cannot resolve its family so nobody can approve /
 * reject / cancel it, PENDING is never trimmed so it stays forever, and
 * DUPLICATE_REQUEST then blocks re-requesting that book permanently. A pointer
 * with no index entry is invisible to every reader, answers the same 404 an
 * unknown id does, and the caller's retry produces a clean record. So the
 * recoverable half is written first.
 *
 * DELETES: creating a request removes nothing here. A create CAN delete —
 * `writeBorrowIndex` drops evicted pointers past BORROW_HISTORY_KEEP — but this
 * 2-entry, all-PENDING index is nowhere near the cap.
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

/** Two-member lending family + a 2-entry current-shape borrow index; returns the
 *  caller's token. See the header → "SEED". */
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
  it("performs exactly 5 KV reads and 2 KV writes against a 2-entry borrow index", async () => {
    const token = await seedFamilyWithBorrowIndex();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(201);
    // The new record's id is server-generated (crypto.randomUUID, `createBorrowRoute`),
    // so it is read back from the response and pinned exactly like the rest.
    const created = (await res.json()) as Json;
    const newRequestId = created.data.requestId as string;

    expect(ops.getKeys()).toEqual([
      // auth middleware, `authMiddleware`
      kvKeys.authToken(token),
      // handler, `getFamilyRecord` — the family record
      kvKeys.family(FAMILY_ID),
      // handler, `isActiveMember` — both parties' pointers, for the
      // active-member checks (#222): caller first, then the lender
      kvKeys.member(USER1),
      kvKeys.member(USER2),
      // handler, `readBorrowIndex` — the index
      kvKeys.borrowsByFamily(FAMILY_ID),
      // No `borrow:{existingRequestId}` reads (#160 item 2): a returning fan-out
      // would add two here — the seed holds a 2-entry index.
    ]);

    // Pointer first (`writeBorrowPointer`), then the index (`writeBorrowIndex`): the recoverable half.
    // See the header → "WRITE ORDER".
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.borrow(newRequestId)}`,
      `put ${kvKeys.borrowsByFamily(FAMILY_ID)}`,
    ]);

    // Removes nothing: this 2-entry, all-PENDING index is nowhere near the cap.
    // See the header → "DELETES".
    expect(ops.deleteKeys()).toEqual([]);

    // Fixed rate-limit cost: two binding calls, zero KV ops; the second keyed on the
    // AUTHENTICATED caller (Inv-6), its NAME encoding the ceiling borrow.ts asked for.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
      {
        name: "RATE_LIMIT_10_PER_MIN",
        key: `ratelimit:user:borrow-create:${USER1}`,
      },
    ]);
  });
});
