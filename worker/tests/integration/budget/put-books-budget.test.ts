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
 * - `ratelimit:{ip}:{minuteBucket}` — 1 get (middleware/rateLimit.ts:232) +
 *   1 put (:257). WASTE. EXPECTED TO DISAPPEAR when issue #160 item 1 lands
 *   (per-IP limiting moves to Cloudflare's native Rate Limiting binding, which
 *   costs no KV op). LOWER the pinned arrays then; do not preserve these.
 * - `ratelimit:user:put-books:{userId}:{hourBucket}` — 1 get
 *   (peekPerUserRateLimit, rateLimit.ts:325) + 1 put (chargePerUserRateLimit,
 *   rateLimit.ts:364); scope "put-books", ceiling 30 per 3600s
 *   (routes/user.ts:443-448). Note the HOURLY bucket index — it is
 *   `floor(now / 3_600_000)`, not the per-minute index the other budgets use.
 *   WASTE, same fate under #160 item 1 — remove both entries when the KV
 *   counter is replaced.
 *   Whatever replaces it MUST stay keyed on the AUTHENTICATED caller, never
 *   on a body/path target id (security-ux Invariant 6) — replace these two
 *   entries with the new mechanism's equivalent assertion; do not simply
 *   delete them, or the keying loses its only automatic check.
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
const PATH = `/api/user/${USER1}/books`;
/** Unique per file so the per-IP counter cannot be shared with another suite. */
const CALLER_IP = "10.0.0.5";
const PINNED_NOW = Date.parse("2026-03-01T12:00:00.000Z");
const MINUTE_BUCKET = Math.floor(PINNED_NOW / 60_000);
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

function measuredRequest(token: string) {
  return app.request(
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

describe("KV budget: PUT /api/user/:id/books", () => {
  it("performs exactly 7 KV reads and 3 KV writes for a family member with no public shelves", async () => {
    const token = await seedMemberWithBooks();

    const ops = watchKvOps(kv);
    const res = await measuredRequest(token);

    expect(res.status).toBe(200);

    expect(ops.getKeys()).toEqual([
      // WASTE (#160 item 1) — per-IP counter read, rateLimit.ts:232
      `ratelimit:${CALLER_IP}:${MINUTE_BUCKET}`,
      // auth middleware, auth.ts:46
      kvKeys.authToken(token),
      // WASTE (#160 item 1) — per-userId counter read (hourly), rateLimit.ts:325
      `ratelimit:user:put-books:${USER1}:${HOUR_BUCKET}`,
      // handler, user.ts:494-498 — three parallel reads, recorded in array order
      kvKeys.user(USER1),
      kvKeys.member(USER1),
      kvKeys.publicShelves(USER1),
      // resolveDisplayName, user.ts:66 — only paid by a caller in a family
      kvKeys.family(FAMILY_ID),
    ]);

    expect(ops.putKeys()).toEqual([
      // WASTE (#160 item 1) — per-IP counter write, rateLimit.ts:257
      `ratelimit:${CALLER_IP}:${MINUTE_BUCKET}`,
      // WASTE (#160 item 1) — per-userId counter write, rateLimit.ts:364
      `ratelimit:user:put-books:${USER1}:${HOUR_BUCKET}`,
      // handler, user.ts:531 — the rebuilt books record
      kvKeys.user(USER1),
    ]);

    // No public shelves seeded, so no snapshot write and no snapshot delete.
    expect(ops.deleteKeys()).toEqual([]);
  });
});
