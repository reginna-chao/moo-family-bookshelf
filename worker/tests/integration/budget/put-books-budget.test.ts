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
 *   by Cloudflare's native Rate Limiting binding (rateLimit.ts:427): zero KV
 *   operations, so `ratelimit:{ip}:{minuteBucket}` is gone from both arrays.
 *   The binding call it was replaced by is pinned in `calls` below instead.
 * - `ratelimit:user:put-books:{userId}:{hourBucket}` — 1 get
 *   (peekPerUserRateLimit, rateLimit.ts:509) + 1 put (chargePerUserRateLimit,
 *   rateLimit.ts:551); scope "put-books", ceiling 30 per 3600s
 *   (routes/user.ts:443-448). Note the HOURLY bucket index — it is
 *   `floor(now / 3_600_000)`, not the per-minute index the other budgets use,
 *   and that is exactly why this pair SURVIVED #160 item 1: the platform
 *   accepts only a 10s or 60s period and this Worker configures 60
 *   (BINDING_PERIOD_SECONDS), so every hourly ceiling stays on KV BY DESIGN.
 *   It is not leftover waste, and the next reader must not
 *   "finish the job" by deleting it — see `bindingForWindow` in
 *   middleware/rateLimit.ts. The key stays on the AUTHENTICATED caller, never
 *   on a body/path target id (security-ux Invariant 6).
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `user:{userId}` (get routes/user.ts:495, put :531), `member:{userId}`
 *   (:496) and `publicshelves:{userId}` (:497) — three parallel reads plus the
 *   record write. Real cost, NOT part of #160: the pointer read is what keeps a
 *   stale books save from resurrecting a revoked share token.
 * - `family:{familyId}` — resolveDisplayName (routes/user.ts:66, reached from
 *   :504) because the caller is in a family; the family record is authoritative
 *   for displayName. Real cost, NOT part of #160. A caller with no
 *   `member:{userId}` entry does not pay it.
 *
 * NOT SEEDED, deliberately: no `publicshelves:{userId}` record and no legacy
 * `publicSharing` field, so `updateAllPublicSnapshots` (routes/user.ts:40-50)
 * writes zero `public:{shareToken}` snapshots. This budget is therefore the
 * FLOOR of a books save; a user with N public shelves pays N extra writes.
 *
 * THE RATE LIMITING BINDINGS ARE INJECTED, deliberately: every production
 * deploy carries all four (worker/wrangler.toml), and a request sent without
 * them falls back to the KV counters — which would re-pin numbers no deployed
 * Worker produces. See tests/helpers/rateLimitBindings.ts.
 *
 * NO DEV_MODE ON THE MEASURED REQUEST, deliberately: both rate-limit layers
 * short-circuit under it (rateLimit.ts:415, :601), which would hide the per-IP
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
/** The "put-books" scope uses a 3600s window (routes/user.ts:447). */
const HOUR_BUCKET = Math.floor(PINNED_NOW / 3_600_000);

let kv: KVNamespace;

/** Book shape accepted by parseBooks (routes/user.ts:306); "" coverUrl is valid. */
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
    books: [book("book-1", BoolFlag.FALSE)],
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
        books: [book("book-1", BoolFlag.TRUE), book("book-2", BoolFlag.FALSE)],
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
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // HOURLY per-userId counter read, rateLimit.ts:509 — stays on KV by
      // design: BINDING_PERIOD_SECONDS is 60, so no binding can serve an
      // hour-long window.
      `ratelimit:user:put-books:${USER1}:${HOUR_BUCKET}`,
      // handler, user.ts:494-498 — three parallel reads, recorded in array order
      kvKeys.user(USER1),
      kvKeys.member(USER1),
      kvKeys.publicShelves(USER1),
      // resolveDisplayName, user.ts:66 — only paid by a caller in a family
      kvKeys.family(FAMILY_ID),
    ]);

    expect(ops.putKeys()).toEqual([
      // HOURLY per-userId counter write, rateLimit.ts:551 — same design note.
      `ratelimit:user:put-books:${USER1}:${HOUR_BUCKET}`,
      // handler, user.ts:531 — the rebuilt books record
      kvKeys.user(USER1),
    ]);

    // No public shelves seeded, so no snapshot write and no snapshot delete.
    expect(ops.deleteKeys()).toEqual([]);

    // The only rate-limit cost that moved off KV on this route: the per-IP
    // tier. The `put-books` ceiling has no binding to move to, so exactly ONE
    // call is expected here and the hourly pair stays in the arrays above.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
    ]);
  });
});
