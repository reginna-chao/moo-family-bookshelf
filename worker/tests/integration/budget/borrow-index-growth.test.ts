/**
 * KV read GROWTH RATE — GET /api/family/{id}/borrow.
 *
 * ACCEPTANCE CRITERION FOR ISSUE #160 ITEM 2 (borrow index denormalisation).
 * The sibling budget files in this directory pin the KV bill of ONE request
 * shape; this file pins how that bill GROWS with the family's borrow history.
 * Today `routes/borrow.ts` (the `Promise.all` over the index at :390-394) reads
 * one `borrow:{requestId}` per index entry, so the read count is O(index) — a
 * family that has borrowed for a year pays for every historical record on every
 * list request. Item 2 of #160 moves the fields the list response needs INTO
 * the index, making the cost O(1).
 *
 * MERGED AS `it.fails()` ON PURPOSE. Against today's handler the assertion
 * throws (the read count grows by ~45 between a 5-entry and a 50-entry index),
 * and `it.fails` turns that expected throw into a PASS — so this file states
 * the target without turning CI red, which `pnpm test` as the merge gate would
 * not tolerate. The moment the handler stops scaling with the index, the
 * assertion succeeds, `it.fails` reports "expected test to fail", and the run
 * goes RED.
 *
 * THE PLAIN `it()` COMPANION IS NOT OPTIONAL. `it.fails` inverts ANY throw
 * into a PASS (@vitest/runner `runTest`), including a broken seed, a non-200,
 * or a changed response shape — so on its own this file could stay green
 * forever after its fixture silently broke, and would then ALSO fail to turn
 * red when #160 item 2 lands. The plain `it()` companion below asserts seed
 * health LOUDLY instead. Keep it when `.fails` is eventually removed.
 *
 * WHEN THAT HAPPENS, REMOVE `.fails` — DO NOT "FIX" THE TEST. A red run here
 * means #160 item 2 has landed and the acceptance criterion is met; the
 * conversion to a plain `it(...)` is the deliberate act that records it. Do not
 * loosen the threshold, do not delete the file, and do not re-pin the old
 * growth rate. See also the NOTE above the index write in
 * `worker/src/routes/borrow.ts`, which points back at this file.
 *
 * NO DEV_MODE ON THE MEASURED REQUESTS, and the Rate Limiting bindings ARE
 * injected: together those two make the measurement see the pipeline a
 * deployed Worker actually runs (see tests/helpers/rateLimitBindings.ts).
 * Since #160 item 1 neither rate-limit layer on this route costs a KV
 * operation at all, so the per-request CONSTANT is now just the auth token
 * read plus the family and index reads — three, whatever the index size. A
 * constant cancels out of the difference either way; what matters is that the
 * pipeline matches the sibling budget files. See the scope caveat at the end
 * of tests/helpers/kvOps.ts.
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
const PATH = `/api/family/${FAMILY_ID}/borrow`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.7";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

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
}

/**
 * Seed a 2-member family with `count` borrow records plus the index listing
 * them, then measure ONE list request.
 */
async function measureBorrowList(
  count: number,
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

  const requestIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const requestId = requestIdAt(i);
    requestIds.push(requestId);
    const record: BorrowRequest = {
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
    };
    await kv.put(kvKeys.borrow(requestId), JSON.stringify(record));
  }
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(requestIds));

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
  return { reads: ops.getKeys().length, listed: body.data.length };
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
  // Plain it(): a broken seed / non-200 / empty response must fail LOUDLY
  // here. Inside the it.fails() below vitest inverts ANY throw into a pass
  // (@vitest/runner runTest), so the growth assertion must not be the only
  // thing between a broken seed and a green run. Holds before AND after #160.
  it("lists every seeded borrow request", async () => {
    // Both sizes the it.fails() case measures — a broken 50-entry path must
    // fail LOUDLY here, not get swallowed by the .fails inversion below.
    expect((await measureBorrowList(5)).listed).toBe(5);
    expect((await measureBorrowList(50)).listed).toBe(50);
  });

  // `it.fails` = "this assertion is EXPECTED to throw today". Remove `.fails`
  // (do not weaken the assertion) once #160 item 2 makes it pass.
  it.fails(
    "does not read more KV keys as the borrow index grows from 5 to 50 entries",
    async () => {
      const small = await measureBorrowList(5);
      const large = await measureBorrowList(50);

      expect(large.reads - small.reads).toBeLessThan(3);
    },
  );
});
