/**
 * KV operation budget — PUT /api/user/{id}/books.
 *
 * WHAT THIS FILE IS (issue #162). It pins the EXACT number AND identity of the
 * KV reads/writes one personal-shelf save performs TODAY, so any change to this
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
 *   by Cloudflare's native Rate Limiting binding (the `rateLimit` middleware): zero KV
 *   operations, so `ratelimit:{ip}:{minuteBucket}` is gone from both arrays.
 *   The binding call it was replaced by is pinned in `calls` below instead.
 * - `ratelimit:user:put-books:{userId}:{hourBucket}` — 1 get
 *   (peekPerUserRateLimit) + 1 put (chargePerUserRateLimit); scope
 *   "put-books", ceiling 30 per 3600s (routes/user.ts, `putUserBooksRoute`).
 *   Note the HOURLY bucket index — it is
 *   `floor(now / 3_600_000)`, not the per-minute index the other budgets use,
 *   and that is exactly why this pair SURVIVED #160 item 1: the platform
 *   accepts only a 10s or 60s period and this Worker configures 60
 *   (BINDING_PERIOD_SECONDS), so every hourly ceiling stays on KV BY DESIGN.
 *   It is not leftover waste, and the next reader must not
 *   "finish the job" by deleting it — see `bindingForWindow` in
 *   middleware/rateLimit.ts. The key stays on the AUTHENTICATED caller, never
 *   on a body/path target id (security-ux Invariant 6).
 * - `token:{token}` — auth middleware (`authMiddleware`, middleware/auth.ts). Real cost.
 * - `user:{userId}` (get `getUserBooksRecord`, put `putUserBooksRecord`),
 *   `member:{userId}` (`getMemberFamilyId`) and `publicshelves:{userId}`
 *   (`getPublicShelves`) — three parallel reads plus the
 *   record write. Real cost, NOT part of #160: the pointer read is what keeps a
 *   stale books save from resurrecting a revoked share token.
 * - `family:{familyId}` — resolveDisplayName (routes/user.ts, reached from
 *   `putUserBooksRoute`) because the caller is in a family; the family record is authoritative
 *   for displayName. Real cost, NOT part of #160. A caller with no
 *   `member:{userId}` entry does not pay it.
 *
 * NOT SEEDED, deliberately: no `publicshelves:{userId}` record and no legacy
 * `publicSharing` field, so `updateAllPublicSnapshots` (routes/user.ts)
 * writes zero `public:{shareToken}` snapshots. This budget is therefore the
 * FLOOR of a books save; a user with N public shelves pays N extra writes.
 *
 * THE RATE LIMITING BINDINGS ARE INJECTED, deliberately: every production
 * deploy carries all four (worker/wrangler.toml), and a request sent without
 * them falls back to the KV counters — which would re-pin numbers no deployed
 * Worker produces. See tests/helpers/rateLimitBindings.ts.
 *
 * NO DEV_MODE ON THE MEASURED REQUEST, deliberately: both rate-limit layers
 * short-circuit under it (`rateLimit`, `enforcePerUserRateLimit`), which would hide the per-IP
 * binding call pinned in `calls` AND the hourly counter's get + put. See the
 * scope caveat at the end of tests/helpers/kvOps.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../../src/index";
import { createMockKV } from "../../helpers/mockKv";
import { watchKvOps } from "../../helpers/kvOps";
import { createRateLimitBindings } from "../../helpers/rateLimitBindings";
import { seedAuthToken } from "../../helpers/auth";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type FamilyRecord,
  type UserBooksRecord,
} from "../../../src/kv/schema";
import { USER1, USER2 } from "../../helpers/ids";

const FAMILY_ID = "abcd-1234";
const PATH = `/api/user/${USER1}/books`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.5";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");
/** The "put-books" scope uses a 3600s window (routes/user.ts, `putUserBooksRoute`). */
const HOUR_BUCKET = Math.floor(PINNED_NOW / 3_600_000);

/** Real-shaped (12+ digit) bookIds: PUT drops a NEW short id (`dropNewMalformedBookIds`),
 *  so a short one would measure a save that discards half its payload. */
const STORED_BOOK_ID = "210439468000101";
const NEW_BOOK_ID = "210439468000102";

let kv: KVNamespace;

/** Book shape accepted by parseBooks (routes/user.ts); "" coverUrl is valid. */
function book(bookId: string, isShared: BoolFlag): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "Author",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared,
  };
}

/** Caller in a 2-member family with an existing books record; returns their token. */
async function seedMemberWithBooks(): Promise<string> {
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

  const existing: UserBooksRecord = {
    schemaVersion: 1,
    userId: USER1,
    displayName: "Alice",
    books: [book(STORED_BOOK_ID, BoolFlag.FALSE)],
    lastUpdated: new Date(PINNED_NOW).toISOString(),
  };
  await kv.put(kvKeys.user(USER1), JSON.stringify(existing));

  return seedAuthToken(kv, USER1);
}

/** The measured request plus the binding calls it made. */
async function measuredRequest(token: string) {
  const { bindings, calls } = createRateLimitBindings();
  const res = await app.request(
    PATH,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "cf-connecting-ip": CALLER_IP,
      },
      body: JSON.stringify({
        books: [
          book(STORED_BOOK_ID, BoolFlag.TRUE),
          book(NEW_BOOK_ID, BoolFlag.FALSE),
        ],
      }),
    },
    { KV: kv, ...bindings },
  );
  return { res, calls };
}

beforeEach(() => {
  kv = createMockKV();
  // Pin Date so the hourly counter's bucket index in the expected keys is exact.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("KV budget: PUT /api/user/:id/books", () => {
  it("performs exactly 6 KV reads and 2 KV writes for a family member with no public shelves", async () => {
    const token = await seedMemberWithBooks();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(200);

    expect(ops.getKeys()).toEqual([
      // auth middleware, `authMiddleware`
      kvKeys.authToken(token),
      // HOURLY per-userId counter read, `peekPerUserRateLimit` — on KV by design
      // (BINDING_PERIOD_SECONDS is 60; no binding serves an hour).
      `ratelimit:user:put-books:${USER1}:${HOUR_BUCKET}`,
      // handler, `putUserBooksRoute` — three parallel reads, recorded in array order
      kvKeys.user(USER1),
      kvKeys.member(USER1),
      kvKeys.publicShelves(USER1),
      // resolveDisplayName — only paid by a caller in a family
      kvKeys.family(FAMILY_ID),
    ]);

    expect(ops.putKeys()).toEqual([
      // HOURLY per-userId counter write, `chargePerUserRateLimit` — same design note.
      `ratelimit:user:put-books:${USER1}:${HOUR_BUCKET}`,
      // handler, `putUserBooksRecord` — the rebuilt books record
      kvKeys.user(USER1),
    ]);

    // No public shelves seeded, so no snapshot write and no snapshot delete.
    expect(ops.deleteKeys()).toEqual([]);

    // Only the per-IP tier moved off KV: exactly ONE binding call, while the
    // hourly `put-books` pair stays in the arrays above.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
    ]);
  });
});
