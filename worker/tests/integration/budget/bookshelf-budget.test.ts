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
 * - `ratelimit:{ip}:{minuteBucket}` — 1 get (middleware/rateLimit.ts:232) +
 *   1 put (:257). WASTE. EXPECTED TO DISAPPEAR when issue #160 item 1 lands
 *   (per-IP limiting moves to Cloudflare's native Rate Limiting binding, which
 *   costs no KV op). LOWER the pinned arrays then; do not preserve these.
 * - `ratelimit:user:bookshelf:{userId}:{minuteBucket}` — 1 get
 *   (peekPerUserRateLimit, rateLimit.ts:325) + 1 put (chargePerUserRateLimit,
 *   rateLimit.ts:364); scope "bookshelf", ceiling 30 per 60s
 *   (routes/bookshelf.ts:68-73). WASTE, same fate under #160 item 1 — remove
 *   both entries when the KV counter is replaced.
 *   Whatever replaces it MUST stay keyed on the AUTHENTICATED caller, never
 *   on a body/path target id (security-ux Invariant 6) — replace these two
 *   entries with the new mechanism's equivalent assertion; do not simply
 *   delete them, or the keying loses its only automatic check.
 * - `token:{token}` — auth middleware (middleware/auth.ts:46). Real cost.
 * - `member:{userId}` (routes/bookshelf.ts:76), `family:{familyId}` (:82) and
 *   one `user:{memberId}` per member (:96) — the aggregation itself. Inherent
 *   to this endpoint, NOT part of #160; a change here is a real design change.
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
const MINUTE_BUCKET = Math.floor(PINNED_NOW / 60_000);

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

function measuredRequest(token: string) {
  return app.request(
    PATH,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "cf-connecting-ip": CALLER_IP,
      },
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

describe("KV budget: GET /api/family/:id/bookshelf", () => {
  it("performs exactly 7 KV reads and 2 KV writes for a 2-member family", async () => {
    const token = await seedFamilyWithBooks();

    const ops = watchKvOps(kv);
    const res = await measuredRequest(token);

    expect(res.status).toBe(200);

    expect(ops.getKeys()).toEqual([
      // WASTE (#160 item 1) — per-IP counter read, rateLimit.ts:232
      `ratelimit:${CALLER_IP}:${MINUTE_BUCKET}`,
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // WASTE (#160 item 1) — per-userId counter read, rateLimit.ts:325
      `ratelimit:user:bookshelf:${USER1}:${MINUTE_BUCKET}`,
      // handler, bookshelf.ts:76 / :82 / :96 (one per member)
      kvKeys.member(USER1),
      kvKeys.family(FAMILY_ID),
      kvKeys.user(USER1),
      kvKeys.user(USER2),
    ]);

    expect(ops.putKeys()).toEqual([
      // WASTE (#160 item 1) — per-IP counter write, rateLimit.ts:257
      `ratelimit:${CALLER_IP}:${MINUTE_BUCKET}`,
      // WASTE (#160 item 1) — per-userId counter write, rateLimit.ts:364
      `ratelimit:user:bookshelf:${USER1}:${MINUTE_BUCKET}`,
    ]);

    // A read-only aggregation deletes nothing.
    expect(ops.deleteKeys()).toEqual([]);
  });
});
