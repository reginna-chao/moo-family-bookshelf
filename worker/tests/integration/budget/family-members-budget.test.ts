/**
 * KV operation budget — GET /api/family/{id}/members.
 *
 * WHAT THIS FILE IS (issue #162). It pins the EXACT number AND identity of the
 * KV reads/writes one member-list request performs TODAY, so any change to this
 * hot path's KV bill fails a test and has to be changed on purpose. It is a
 * tripwire, not a statement that the current bill is correct.
 *
 * WHY THE ANNOTATION BELOW MATTERS. Some pinned entries ARE the waste that
 * issue #160 exists to remove. Without saying so here, a later implementer
 * reads a test-backed set of numbers as the right answer and preserves them —
 * the same mechanism by which the "known limitation" comment in
 * middleware/rateLimit.ts stopped reading as a debt note and started reading as
 * a permanent authorisation. #162 exists to stop that repeating.
 *
 * PER-KEY CLASSIFICATION
 * - Per-IP counter — REMOVED by #160 item 1. The standard tier is now counted
 *   by Cloudflare's native Rate Limiting binding (rateLimit.ts:427): zero KV
 *   operations, so `ratelimit:{ip}:{minuteBucket}` is gone. On THIS endpoint it
 *   was the only write of the whole request, so `putKeys()` is now the empty
 *   array. The binding call it was replaced by is pinned in `calls` below.
 * - NO per-userId counter here, unlike every other endpoint in this directory:
 *   the members handler (routes/family.ts:792-827) never calls
 *   `enforcePerUserRateLimit`. So `calls` below holds exactly ONE entry, the
 *   per-IP one, and no `ratelimit:user:*` key may appear in either array. If a
 *   second binding call ever shows up, a rate limit was added to a read-only
 *   endpoint — treat that as the change to justify, not as drift to absorb.
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `member:{userId}` (routes/family.ts:810) and `family:{familyId}` (:815) —
 *   membership check then the record itself. Real cost, and FLAT in the member
 *   count: the response is the family record, so there is no per-member
 *   fan-out to remove (contrast the bookshelf aggregation).
 *
 * THE RATE LIMITING BINDINGS ARE INJECTED, deliberately: every production
 * deploy carries all four (worker/wrangler.toml), and a request sent without
 * them falls back to the KV counters — which would re-pin numbers no deployed
 * Worker produces. See tests/helpers/rateLimitBindings.ts.
 *
 * NO DEV_MODE ON THE MEASURED REQUEST, deliberately: the per-IP rate-limit
 * layer short-circuits under it (rateLimit.ts:415) ahead of the binding lookup,
 * which would hide the fixed cost pinned in `calls`. See the scope caveat at
 * the end of tests/helpers/kvOps.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../../src/index";
import { createMockKV } from "../../helpers/mockKv";
import { watchKvOps } from "../../helpers/kvOps";
import { createRateLimitBindings } from "../../helpers/rateLimitBindings";
import { seedAuthToken } from "../../helpers/auth";
import { BoolFlag, kvKeys, type FamilyRecord } from "../../../src/kv/schema";
import { USER1, USER2 } from "../../helpers/ids";

const FAMILY_ID = "abcd-1234";
const PATH = `/api/family/${FAMILY_ID}/members`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.6";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/** Two-member family with the caller (USER1) as owner; returns their token. */
async function seedFamily(): Promise<string> {
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

describe("KV budget: GET /api/family/:id/members", () => {
  it("performs exactly 3 KV reads and no KV write for a 2-member family", async () => {
    const token = await seedFamily();

    const ops = watchKvOps(kv);
    const { res, calls } = await measuredRequest(token);

    expect(res.status).toBe(200);
    // Flat in the member count: both members come from the one family read.
    const body = (await res.json()) as Json;
    expect(body.data.members).toHaveLength(2);

    expect(ops.getKeys()).toEqual([
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // handler, family.ts:810 / :815 — no per-userId counter on this route
      kvKeys.member(USER1),
      kvKeys.family(FAMILY_ID),
    ]);

    // A read-only listing now writes and deletes nothing at all: the per-IP
    // counter was this request's ONLY write before #160 item 1.
    expect(ops.putKeys()).toEqual([]);
    expect(ops.deleteKeys()).toEqual([]);

    // The whole fixed rate-limit cost of this endpoint: ONE per-IP binding
    // call. A second entry here would mean a per-userId ceiling was added to a
    // read-only route.
    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: `ratelimit:${CALLER_IP}` },
    ]);
  });
});
