/**
 * KV operation budget — GET /api/family/{id}/bookshelf.
 *
 * WHAT THIS FILE IS (issue #162). It pins the EXACT number AND identity of the
 * KV reads/writes one bookshelf request performs TODAY, so any change to this
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
 * - Per-userId `bookshelf` counter — REMOVED by #160 item 1 for the same
 *   reason (rateLimit.ts:608); scope "bookshelf", ceiling 30 per 60s
 *   (routes/bookshelf.ts:68-73), which is what selects RATE_LIMIT_30_PER_MIN.
 *   It MUST stay keyed on the AUTHENTICATED caller, never on a body/path
 *   target id (security-ux Invariant 6): now that the KV key is gone, the
 *   `calls` assertion below is that rule's only automatic check.
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `member:{userId}` (routes/bookshelf.ts:76), `family:{familyId}` (:82) and
 *   one `user:{memberId}` per member (:96) — the aggregation itself. Inherent
 *   to this endpoint, NOT part of #160; a change here is a real design change.
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
  kvKeys,
  type BookEntry,
  type FamilyRecord,
  type UserBooksRecord,
} from "../../../src/kv/schema";
import { USER1, USER2 } from "../../helpers/ids";

const FAMILY_ID = "abcd-1234";
const PATH = `/api/family/${FAMILY_ID}/bookshelf`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.1";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

let kv: KVNamespace;

function sharedBook(bookId: string): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "Author",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  };
}

/** Two-member family, both with a shared book, plus the caller's auth token. */
async function seedFamilyWithBooks(): Promise<string> {
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
  for (const userId of [USER1, USER2]) {
    await kv.put(kvKeys.member(userId), FAMILY_ID);
    const record: UserBooksRecord = {
      schemaVersion: 1,
      userId,
      displayName: userId === USER1 ? "Alice" : "Bob",
      books: [sharedBook(`book-${userId.slice(0, 4)}`)],
      lastUpdated: new Date(PINNED_NOW).toISOString(),
    };
    await kv.put(kvKeys.user(userId), JSON.stringify(record));
  }
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

describe("KV budget: GET /api/family/:id/bookshelf", () => {
  it("performs exactly 5 KV reads and no KV write for a 2-member family", async () => {
    const token = await seedFamilyWithBooks();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(200);

    expect(ops.getKeys()).toEqual([
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // handler, bookshelf.ts:76 / :82 / :96 (one per member)
      kvKeys.member(USER1),
      kvKeys.family(FAMILY_ID),
      kvKeys.user(USER1),
      kvKeys.user(USER2),
    ]);

    // A read-only aggregation writes nothing at all now that both rate-limit
    // counters live on the platform.
    expect(ops.putKeys()).toEqual([]);
    expect(ops.deleteKeys()).toEqual([]);

    // The fixed per-request rate-limit cost, in the form it now takes: two
    // binding calls, zero KV operations. The second key carries the
    // AUTHENTICATED caller's id (Invariant 6), and the binding NAME encodes the
    // ceiling routes/bookshelf.ts asked for.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
      {
        name: "RATE_LIMIT_30_PER_MIN",
        key: `ratelimit:user:bookshelf:${USER1}`,
      },
    ]);
  });
});
