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
 * - `ratelimit:{ip}:{minuteBucket}` — 1 get (middleware/rateLimit.ts:232) +
 *   1 put (:257). WASTE. EXPECTED TO DISAPPEAR when issue #160 item 1 lands
 *   (per-IP limiting moves to Cloudflare's native Rate Limiting binding, which
 *   costs no KV op). LOWER the pinned arrays then; do not preserve these.
 * - `ratelimit:user:borrow-create:{userId}:{minuteBucket}` — 1 get
 *   (peekPerUserRateLimit, rateLimit.ts:325) + 1 put (chargePerUserRateLimit,
 *   rateLimit.ts:364); scope "borrow-create", ceiling 10 per 60s
 *   (routes/borrow.ts:199-204). WASTE, same fate under #160 item 1 — remove
 *   both entries when the KV counter is replaced.
 *   Whatever replaces it MUST stay keyed on the AUTHENTICATED caller, never
 *   on a body/path target id (security-ux Invariant 6) — replace these two
 *   entries with the new mechanism's equivalent assertion; do not simply
 *   delete them, or the keying loses its only automatic check.
 * - `borrow:{existingRequestId}` — ONE READ PER ENTRY of the family's borrow
 *   index (routes/borrow.ts:267-271), only to answer the DUPLICATE_REQUEST
 *   check. WASTE: this read count grows with the family's borrow history and is
 *   EXPECTED TO DISAPPEAR (or collapse to O(1)) when issue #160 item 2 lands
 *   (borrow index denormalisation — the index itself carries what the check
 *   needs, so there is no per-entry fan-out). Two such reads are pinned below
 *   because the seed holds a 2-entry index; after #160 item 2 they must be
 *   DELETED from the array, not preserved.
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `family:{familyId}` (routes/borrow.ts:208), `borrows:family:{familyId}`
 *   (get :263, put :329) and the new `borrow:{requestId}` (put :328, the
 *   `Promise.all` under the "No atomic CAS" NOTE) — real cost of creating the
 *   request.
 *
 * NO DEV_MODE ON THE MEASURED REQUEST, deliberately: both rate-limit paths
 * short-circuit under it (rateLimit.ts:208, :407), which would hide exactly the
 * four counter ops annotated as waste above. See the scope caveat at the end of
 * tests/helpers/kvOps.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../../src/index";
import { createMockKV } from "../../helpers/mockKv";
import { watchKvOps } from "../../helpers/kvOps";
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
const CALLER_IP = "10.0.0.2";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");
const MINUTE_BUCKET = Math.floor(PINNED_NOW / 60_000);

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

/** Two-member lending family + a 2-entry borrow index; returns the caller's token. */
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

  for (const [i, requestId] of EXISTING_IDS.entries()) {
    const record: BorrowRequest = {
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
    };
    await kv.put(kvKeys.borrow(requestId), JSON.stringify(record));
  }
  await kv.put(kvKeys.borrowsByFamily(FAMILY_ID), JSON.stringify(EXISTING_IDS));

  return seedAuthToken(kv, USER1);
}

function measuredRequest(token: string) {
  return app.request(
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
    { KV: kv },
  );
}

beforeEach(() => {
  kv = createMockKV();
  // Pin Date so the rate-limit bucket indexes in the expected keys are exact.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("KV budget: POST /api/family/:id/borrow", () => {
  it("performs exactly 7 KV reads and 4 KV writes against a 2-entry borrow index", async () => {
    const token = await seedFamilyWithBorrowIndex();

    const ops = watchKvOps(kv);
    const res = await measuredRequest(token);

    expect(res.status).toBe(201);
    // The new record's id is server-generated (crypto.randomUUID, borrow.ts:292),
    // so it is read back from the response and pinned exactly like the rest.
    const created = (await res.json()) as Json;
    const newRequestId = created.data.requestId as string;

    expect(ops.getKeys()).toEqual([
      // WASTE (#160 item 1) — per-IP counter read, rateLimit.ts:232
      `ratelimit:${CALLER_IP}:${MINUTE_BUCKET}`,
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // WASTE (#160 item 1) — per-userId counter read, rateLimit.ts:325
      `ratelimit:user:borrow-create:${USER1}:${MINUTE_BUCKET}`,
      // handler, borrow.ts:208 / :263
      kvKeys.family(FAMILY_ID),
      kvKeys.borrowsByFamily(FAMILY_ID),
      // WASTE (#160 item 2) — one read per index entry, borrow.ts:267-271
      kvKeys.borrow(EXISTING_IDS[0]),
      kvKeys.borrow(EXISTING_IDS[1]),
    ]);

    expect(ops.putKeys()).toEqual([
      // WASTE (#160 item 1) — per-IP counter write, rateLimit.ts:257
      `ratelimit:${CALLER_IP}:${MINUTE_BUCKET}`,
      // WASTE (#160 item 1) — per-userId counter write, rateLimit.ts:364
      `ratelimit:user:borrow-create:${USER1}:${MINUTE_BUCKET}`,
      // handler, borrow.ts:328 / :329
      kvKeys.borrow(newRequestId),
      kvKeys.borrowsByFamily(FAMILY_ID),
    ]);

    // Creating a request removes nothing.
    expect(ops.deleteKeys()).toEqual([]);
  });
});
