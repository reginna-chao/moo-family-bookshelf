/**
 * KV read GROWTH RATE — GET /api/family/{id}/borrow.
 *
 * ACCEPTANCE CRITERION FOR ISSUE #160 ITEM 2 (borrow index denormalisation),
 * now MET. The sibling budget files in this directory pin the KV bill of ONE
 * request shape; this file pins how that bill GROWS with the family's borrow
 * history. `routes/borrow.ts` used to read one `borrow:{requestId}` per index
 * entry, so the read count was O(index) — a family that had borrowed for a year
 * paid for every historical record on every list request. Item 2 moved the
 * records INTO `borrows:family:{familyId}`, so `readBorrowIndex`
 * (services/borrowIndex.ts) answers the whole listing from one key.
 *
 * IT WAS AN `it.fails()` UNTIL ITEM 2 LANDED. That inversion existed only so
 * the target could be stated without turning CI red while the handler still
 * fanned out. Item 2 has landed, the assertion passes, and the case below is a
 * plain `it()` — which is the deliberate act that records the criterion as met.
 * Do not re-add `.fails`, and do not loosen the assertion: it now pins a
 * DELTA OF EXACTLY 0, not the old `< 3` tolerance. `< 3` was slack for an
 * unlanded target; the migrated read path costs the same three keys (auth
 * token, family record, index) whatever the index holds, so anything above 0 is
 * a real regression and there is no reason to leave room for one.
 *
 * THE LEGACY CASE IS NOT A REGRESSION — it is design decision D3. A family
 * still on the pre-migration `string[]` index STILL fans out on GET, and the
 * second case below pins exactly that (delta 45 across 5 vs 50 entries) rather
 * than pretending it does not happen. Migration is WRITE-PATH ONLY (create,
 * PATCH, member-removal cancellation), because a GET that rewrote KV would turn
 * every reader into a writer and hand an unauthenticated-ish read path a write
 * lever. So an un-migrated family keeps the old read cost until its first
 * borrow write, and that case also asserts the listing performs NO put or
 * delete at all — the half of D3 that actually matters.
 *
 * THE PLAIN SEED-HEALTH COMPANION IS NOT OPTIONAL. It asserts LOUDLY that both
 * fixtures at both sizes really list what they seeded, so neither growth case
 * can be satisfied by a broken seed, a non-200, or an empty response — a delta
 * of 0 between two empty listings would otherwise look like success.
 *
 * NO DEV_MODE ON THE MEASURED REQUESTS, and the Rate Limiting bindings ARE
 * injected: together those two make the measurement see the pipeline a
 * deployed Worker actually runs (see tests/helpers/rateLimitBindings.ts).
 * Since #160 item 1 neither rate-limit layer on this route costs a KV
 * operation at all, so the per-request CONSTANT is just the auth token read
 * plus the family and index reads — three, whatever the index size. A constant
 * cancels out of the difference either way; what matters is that the pipeline
 * matches the sibling budget files. See the scope caveat at the end of
 * tests/helpers/kvOps.ts.
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
const CALLER_IP = "10.0.0.7";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

/**
 * Fixed per-request read cost of a migrated listing: the auth token, the family
 * record, and the index. Pinned as a POSITIVE companion to the delta-of-0
 * assertion — without it, a fixture that somehow made both measurements read
 * nothing would satisfy the delta and prove nothing.
 */
const MIGRATED_LIST_READS = 3;

/** How the family's borrow index is stored — before vs after #160 item 2. */
type IndexShape =
  /** Migrated: `borrows:family:{id}` holds the records, `borrow:{id}` a pointer. */
  | "new"
  /** Pre-migration: `borrows:family:{id}` holds requestIds, `borrow:{id}` the record. */
  | "legacy";

/**
 * Deterministic v4-shaped requestId (RequestIdSchema, src/schemas/common.ts)
 * built from a zero-padded index, so both measurements seed identical shapes.
 */
function requestIdAt(index: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`;
}

/** What one measured list request cost, and what it actually returned. */
interface BorrowListMeasurement {
  /** KV `get` calls the measured request performed. */
  reads: number;
  /** Borrow records the response listed — seed health, stable across #160. */
  listed: number;
  /** Every `put` / `delete` the measured request performed, in order. */
  writes: string[];
}

/**
 * Seed a 2-member family with `count` borrow records in the given index
 * `shape`, then measure ONE list request.
 */
async function measureBorrowList(
  count: number,
  shape: IndexShape,
): Promise<BorrowListMeasurement> {
  const kv = createMockKV();

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

  const records: BorrowRequest[] = [];
  for (let i = 0; i < count; i++) {
    records.push({
      requestId: requestIdAt(i),
      familyId: FAMILY_ID,
      borrowerId: USER1,
      borrowerName: "Alice",
      ownerId: USER2,
      bookId: `book-${i}`,
      bookTitle: `Book ${i}`,
      bookAuthor: "Author",
      bookCoverUrl: "",
      // PENDING throughout: `trimBorrowIndex` never evicts an active request,
      // so a 50-entry fixture survives intact and the two shapes stay
      // comparable. (A GET writes nothing either way — see the legacy case.)
      status: BorrowStatus.PENDING,
      createdAt: new Date(PINNED_NOW).toISOString(),
      updatedAt: new Date(PINNED_NOW).toISOString(),
    });
  }

  for (const record of records) {
    // Migrated: only the pointer. Un-migrated: the full record, which is what
    // the fan-out below reads one key at a time.
    const value: BorrowPointer | BorrowRequest =
      shape === "new" ? { familyId: FAMILY_ID } : record;
    await kv.put(kvKeys.borrow(record.requestId), JSON.stringify(value));
  }
  await kv.put(
    kvKeys.borrowsByFamily(FAMILY_ID),
    JSON.stringify(shape === "new" ? records : records.map((r) => r.requestId)),
  );

  const token = await seedAuthToken(kv, USER1);

  // Recorder installed AFTER seeding: only the measured request is counted.
  const ops = watchKvOps(kv);
  const { bindings } = createRateLimitBindings();
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

  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown[] };
  return {
    reads: ops.getKeys().length,
    listed: body.data.length,
    writes: ops.writeTrail(),
  };
}

beforeEach(() => {
  // Pin Date so both measurements land in the same rate-limit buckets.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("KV read growth: GET /api/family/:id/borrow", () => {
  // Seed health for every fixture the growth cases below rely on. A broken
  // seed, a non-200 or an empty response must fail LOUDLY here, so that a
  // delta assertion can never be satisfied by two equally-broken measurements.
  it.each([
    { shape: "new" as const, count: 5 },
    { shape: "new" as const, count: 50 },
    { shape: "legacy" as const, count: 5 },
    { shape: "legacy" as const, count: 50 },
  ])(
    "lists every seeded borrow request ($shape index, $count entries)",
    async ({ shape, count }) => {
      expect((await measureBorrowList(count, shape)).listed).toBe(count);
    },
  );

  it("reads the same number of KV keys whether the migrated index holds 5 or 50 entries", async () => {
    const small = await measureBorrowList(5, "new");
    const large = await measureBorrowList(50, "new");

    // Positive companion: the constant is really being measured, not zero.
    expect(small.reads).toBe(MIGRATED_LIST_READS);
    expect(large.reads).toBe(MIGRATED_LIST_READS);

    // #160 item 2's acceptance criterion. Exactly 0 — see the header.
    expect(large.reads - small.reads).toBe(0);
  });

  it("still reads one key per entry for an un-migrated legacy index, and writes nothing", async () => {
    const small = await measureBorrowList(5, "legacy");
    const large = await measureBorrowList(50, "legacy");

    // Design decision D3, pinned rather than papered over: migration is
    // write-path only, so a family that has not written since the change keeps
    // paying the fan-out — one `borrow:{requestId}` read per index entry, on
    // top of the same 3-key constant.
    expect(small.reads).toBe(MIGRATED_LIST_READS + 5);
    expect(large.reads).toBe(MIGRATED_LIST_READS + 50);
    expect(large.reads - small.reads).toBe(45);

    // …and the listing does NOT migrate the index it just fanned out over. A
    // GET that wrote would make every reader a writer; `writeTrail()` covers
    // puts AND deletes, so an "opportunistic migration" added to the read path
    // fails here.
    expect(small.writes).toEqual([]);
    expect(large.writes).toEqual([]);
  });
});
