/**
 * DELETE /api/family/:id/kicked/:uid — the owner lifts a removal ban (un-kick).
 *
 * The kicked tombstone (`kicked:{familyId}:{userId}`, written by
 * `DELETE /api/family/:id/member/:uid` and covered in kickedTombstone.test.ts)
 * makes an owner-initiated removal stick for 6 hours. This route is the remedy
 * for a removal made by mistake: the owner deletes the key on demand, and the
 * user may rejoin with the sync code straight away instead of waiting the TTL
 * out. The TTL therefore becomes the UNATTENDED recovery bound, not the only one.
 *
 * Driven over the real HTTP path (`app.request` against the Hono app + a mock
 * KV) because every property here is a contract BETWEEN handlers: this DELETE
 * removes the key, `POST /:id/join` stops refusing on it, and the family record
 * — owned by a third handler — must stay untouched.
 *
 * Four things this suite exists to pin, beyond the happy path:
 * - the ban really lifts (join goes from 403 MEMBER_REMOVED to 200);
 * - lifting it is NOT a re-add — the member list is unchanged until the user
 *   rejoins themselves, so security-ux Invariant 4 still holds;
 * - the handler is IDEMPOTENT and READ-FREE, so the response can never become an
 *   oracle for "was this userId kicked?" — a never-kicked target, an expired
 *   tombstone and a repeat call all answer byte-identically;
 * - only the owner OF THAT `:id` can call it, and the key it deletes is derived
 *   from the same `:id`, so no caller can reach another family's tombstone.
 *
 * Expiry is modelled by DELETING the key: `createMockKV` keeps an accepted put
 * readable forever (see the mock's own doc comment), so "the tombstone expired"
 * and "the tombstone was already cleared" are the same observable state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken, tokenFor } from "../helpers/auth";
import {
  BoolFlag,
  kvKeys,
  KICKED_TOMBSTONE_TTL_SECONDS,
  type FamilyRecord,
  type KickedRecord,
} from "../../src/kv/schema";
import {
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import { FAMILY_WRITE_LIMIT } from "../../src/routes/family";
import { USER1, USER2, USER3, USER4, USER5, OUTSIDER } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/** Family owner — the only caller entitled to lift a ban on their family. */
const OWNER = USER1;
/** The member the owner removes, and later un-kicks. */
const KICKED = USER2;
/** An ordinary, non-owner member of the same family. */
const MEMBER = USER3;
/** Owner of a second, unrelated household. */
const OTHER_OWNER = USER4;
/** A userId with no relation to anything — never joined, never removed. */
const STRANGER = USER5;

/**
 * The production 繁中 copy of the un-kick ownership refusal (`routes/family.ts`).
 * Asserted through `app.request`, so it hits the real throw site rather than a
 * test-local duplicate (test.md, "User-visible copy needs a production-anchored
 * assertion"). Deliberately distinct from the remove-member NOT_OWNER copy
 * ("只有管理者可以移除其他成員") — same code, different action.
 */
const NOT_OWNER_MESSAGE = "只有管理者可以解除移除限制";

/** The production 繁中 copy of the join-side tombstone refusal. */
const MEMBER_REMOVED_MESSAGE = "你已被管理者移出此家庭，暫時無法重新加入";

/** The exact success envelope: `{ cleared: 1 }` with the BoolFlag convention. */
const CLEARED_BODY = JSON.stringify({ data: { cleared: BoolFlag.TRUE } });

// ---------------------------------------------------------------------------
// Helpers — real app, mock KV, DEV_MODE so the limiters never interfere with
// the behaviour under test (the ceiling gets its own suite at the bottom).
// ---------------------------------------------------------------------------

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamily(userId: string) {
  const res = await request("POST", "/api/family", { userId });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    ownerToken: json.data.authToken as string,
  };
}

function join(familyId: string, userId: string) {
  return request("POST", `/api/family/${familyId}/join`, { userId });
}

function removeMember(
  familyId: string,
  targetUserId: string,
  callerToken: string,
) {
  return request(
    "DELETE",
    `/api/family/${familyId}/member/${targetUserId}`,
    undefined,
    callerToken,
  );
}

function clearKicked(
  familyId: string,
  targetUserId: string,
  callerToken?: string,
) {
  return request(
    "DELETE",
    `/api/family/${familyId}/kicked/${targetUserId}`,
    undefined,
    callerToken,
  );
}

function readTombstone(familyId: string, userId: string) {
  return kv.get<KickedRecord>(kvKeys.kicked(familyId, userId), "json");
}

async function memberIds(familyId: string, authToken: string) {
  const res = await request(
    "GET",
    `/api/family/${familyId}/members`,
    undefined,
    authToken,
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as Json;
  return (json.data.members as { userId: string }[]).map((m) => m.userId);
}

/** OWNER's family with KICKED already removed from it — the shared starting point. */
async function familyWithRemovedMember() {
  const { familyId, ownerToken } = await createFamily(OWNER);
  expect((await join(familyId, KICKED)).status).toBe(200);
  expect((await removeMember(familyId, KICKED, ownerToken)).status).toBe(200);
  expect(await readTombstone(familyId, KICKED)).not.toBeNull();
  return { familyId, ownerToken };
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  // watchKvOps installs vi.spyOn handlers and does not clean up after itself.
  vi.restoreAllMocks();
});

// ===========================================================================
// Lifting the ban
// ===========================================================================

describe("DELETE /api/family/:id/kicked/:uid — lifting the removal ban", () => {
  it("should answer 200 { cleared: 1 } and drop the tombstone key", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();

    const res = await clearKicked(familyId, KICKED, ownerToken);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { cleared: BoolFlag.TRUE } });
    expect(await readTombstone(familyId, KICKED)).toBeNull();
  });

  it("should let the removed member rejoin with the sync code straight away", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();

    // Before: the join the removed client retries on its own is refused.
    const refused = await join(familyId, KICKED);
    expect(refused.status).toBe(403);
    const refusedJson = (await refused.json()) as Json;
    expect(refusedJson.error.code).toBe("MEMBER_REMOVED");
    expect(refusedJson.error.message).toBe(MEMBER_REMOVED_MESSAGE);

    expect((await clearKicked(familyId, KICKED, ownerToken)).status).toBe(200);

    // After: the very same request succeeds — no waiting out the 6-hour TTL.
    const rejoin = await join(familyId, KICKED);
    expect(rejoin.status).toBe(200);
    const rejoinJson = (await rejoin.json()) as Json;
    expect(rejoinJson.data.familyId).toBe(familyId);
    expect(rejoinJson.data.authToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await memberIds(familyId, ownerToken)).toEqual([OWNER, KICKED]);
  });

  it("should NOT re-add the removed member to the family", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();
    const recordBefore = await kv.get(kvKeys.family(familyId));

    expect((await clearKicked(familyId, KICKED, ownerToken)).status).toBe(200);

    // security-ux Invariant 4: removal is immediate and only reversible by an
    // explicit rejoin. Un-kick lifts the ban, nothing more — the family record
    // is byte-identical, the membership and auth keys stay torn down.
    expect(await kv.get(kvKeys.family(familyId))).toBe(recordBefore);
    expect(await memberIds(familyId, ownerToken)).toEqual([OWNER]);
    expect(await kv.get(kvKeys.member(KICKED))).toBeNull();
    expect(await kv.get(kvKeys.auth(KICKED))).toBeNull();

    // Only the user's own rejoin puts them back.
    expect((await join(familyId, KICKED)).status).toBe(200);
    expect(await memberIds(familyId, ownerToken)).toEqual([OWNER, KICKED]);
  });

  it("should let the owner re-apply the ban after lifting it", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();
    await clearKicked(familyId, KICKED, ownerToken);
    expect((await join(familyId, KICKED)).status).toBe(200);

    // Un-kick is not a permanent amnesty: the owner keeps their removal
    // authority, and the fresh tombstone carries the production TTL again.
    expect((await removeMember(familyId, KICKED, ownerToken)).status).toBe(200);

    expect(getPutTtl(kv, kvKeys.kicked(familyId, KICKED))).toBe(
      KICKED_TOMBSTONE_TTL_SECONDS,
    );
    expect((await join(familyId, KICKED)).status).toBe(403);
  });
});

// ===========================================================================
// Owner-only, and scoped to the owner's OWN family
// ===========================================================================

describe("DELETE /api/family/:id/kicked/:uid — owner-only", () => {
  /**
   * Two unrelated households that both removed the SAME userId.
   *
   * Family A keeps its vacated seat FREE on purpose: a family created through
   * the API holds two members, and the last case has to prove that lifting A's
   * ban really re-admits the user — a full family would answer 409 FAMILY_FULL
   * and prove nothing about the tombstone.
   */
  async function twoFamiliesBanningTheSameUser() {
    const { familyId: familyA, ownerToken: tokenA } =
      await familyWithRemovedMember();

    const { familyId: familyB, ownerToken: tokenB } =
      await createFamily(OTHER_OWNER);
    expect((await join(familyB, KICKED)).status).toBe(200);
    expect((await removeMember(familyB, KICKED, tokenB)).status).toBe(200);

    return { familyA, tokenA, familyB, tokenB };
  }

  it("should refuse an ordinary member with 403 NOT_OWNER and keep the ban in force", async () => {
    // MEMBER takes the seat KICKED vacated, so the caller here is a real member
    // of the family whose ban they are trying to lift — and still not its owner.
    const { familyId: familyA, ownerToken: tokenA } =
      await familyWithRemovedMember();
    const memberJoin = await join(familyA, MEMBER);
    expect(memberJoin.status).toBe(200);
    const memberToken = ((await memberJoin.json()) as Json).data
      .authToken as string;

    const res = await clearKicked(familyA, KICKED, memberToken);

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_OWNER");
    expect(json.error.message).toBe(NOT_OWNER_MESSAGE);
    expect(json.data).toBeUndefined();

    // The ban is untouched, in KV and over the join path alike.
    expect(await readTombstone(familyA, KICKED)).not.toBeNull();
    const rejoin = await join(familyA, KICKED);
    expect(rejoin.status).toBe(403);
    expect(((await rejoin.json()) as Json).error.code).toBe("MEMBER_REMOVED");
    expect(await memberIds(familyA, tokenA)).toEqual([OWNER, MEMBER]);
  });

  it("should refuse another family's owner with 403 NOT_OWNER", async () => {
    const { tokenA, familyB } = await twoFamiliesBanningTheSameUser();

    // A owns a family, but not THIS one — holding an owner token somewhere else
    // grants nothing here.
    const res = await clearKicked(familyB, KICKED, tokenA);

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("NOT_OWNER");
    expect(await readTombstone(familyB, KICKED)).not.toBeNull();
    expect((await join(familyB, KICKED)).status).toBe(403);
  });

  it("should clear only the caller's own family tombstone when the same user is banned twice", async () => {
    const { familyA, tokenA, familyB } = await twoFamiliesBanningTheSameUser();

    // The key is built from the path `:id` the caller was just proven to own,
    // so the same `:uid` in another household cannot be reached.
    const res = await clearKicked(familyA, KICKED, tokenA);

    expect(res.status).toBe(200);
    expect(await readTombstone(familyA, KICKED)).toBeNull();
    expect(await readTombstone(familyB, KICKED)).not.toBeNull();

    // Asserted in this order: once KICKED rejoins A they hold a membership, so
    // a later join of B would answer 409 ALREADY_IN_FAMILY and stop proving
    // anything about B's tombstone.
    const stillBannedInB = await join(familyB, KICKED);
    expect(stillBannedInB.status).toBe(403);
    expect(((await stillBannedInB.json()) as Json).error.code).toBe(
      "MEMBER_REMOVED",
    );
    expect((await join(familyA, KICKED)).status).toBe(200);
  });

  it("should let the NEW owner lift the ban after a transfer, and refuse the founder", async () => {
    // MEMBER takes the seat KICKED vacated, then ownership moves to them.
    const { familyId, ownerToken } = await familyWithRemovedMember();
    const memberJoin = await join(familyId, MEMBER);
    expect(memberJoin.status).toBe(200);
    const memberToken = ((await memberJoin.json()) as Json).data
      .authToken as string;

    const transfer = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { newOwnerId: MEMBER },
      ownerToken,
    );
    expect(transfer.status).toBe(200);

    // Authority is re-read from `record.ownerId` on every request, never carried
    // by the token: the founder's token is still perfectly valid — it simply no
    // longer belongs to an owner — and the ban they placed survives their loss
    // of authority.
    const refused = await clearKicked(familyId, KICKED, ownerToken);
    expect(refused.status).toBe(403);
    const refusedJson = (await refused.json()) as Json;
    expect(refusedJson.error.code).toBe("NOT_OWNER");
    expect(refusedJson.error.message).toBe(NOT_OWNER_MESSAGE);
    expect(await readTombstone(familyId, KICKED)).not.toBeNull();

    // The token MEMBER was issued as an ordinary member — refused by the case
    // above — now clears the ban, because the record says they own the family.
    const lifted = await clearKicked(familyId, KICKED, memberToken);
    expect(lifted.status).toBe(200);
    expect(await lifted.text()).toBe(CLEARED_BODY);
    expect(await readTombstone(familyId, KICKED)).toBeNull();
  });
});

// ===========================================================================
// Idempotent, read-free, and never an oracle
//
// The handler deletes the key WITHOUT reading it first. That is what makes a
// retry after a failed call safe, and it is also what keeps the response from
// disclosing whether the target was ever kicked — a property worth pinning even
// though the caller is an owner who is entitled to know: it means no future
// change can turn this route into a membership probe.
// ===========================================================================

describe("DELETE /api/family/:id/kicked/:uid — idempotent and read-free", () => {
  it("should answer identically whether the tombstone is live, already gone, or never existed", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();

    // (1) a live tombstone
    const live = await clearKicked(familyId, KICKED, ownerToken);
    // (2) the same target again — the key is gone now, which is exactly the
    //     state an EXPIRED tombstone leaves behind (the mock never expires
    //     anything, so deleting is the expiry model).
    const alreadyGone = await clearKicked(familyId, KICKED, ownerToken);
    // (3) a userId this family never removed at all
    const neverKicked = await clearKicked(familyId, STRANGER, ownerToken);

    expect([live.status, alreadyGone.status, neverKicked.status]).toEqual([
      200, 200, 200,
    ]);
    expect([
      await live.text(),
      await alreadyGone.text(),
      await neverKicked.text(),
    ]).toEqual([CLEARED_BODY, CLEARED_BODY, CLEARED_BODY]);
  });

  it("should stay 200 however many times it is repeated", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await clearKicked(familyId, KICKED, ownerToken);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CLEARED_BODY);
    }

    // Repeats change nothing beyond the first: the ban is lifted, not re-armed.
    expect(await readTombstone(familyId, KICKED)).toBeNull();
    expect((await join(familyId, KICKED)).status).toBe(200);
  });

  it("should delete the tombstone without ever reading it", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();
    const kickedKey = kvKeys.kicked(familyId, KICKED);
    const ops = watchKvOps(kv);

    expect((await clearKicked(familyId, KICKED, ownerToken)).status).toBe(200);

    // A `get` here would let the response depend on whether the key existed —
    // the oracle the idempotent contract rules out — and would cost a KV read
    // the handler does not need.
    expect(ops.getKeys()).not.toContain(kickedKey);
    // The delete is the handler's ONLY mutation: no family-record write, no
    // membership write. Un-kick lifts the ban, it re-adds nobody.
    expect(ops.writeTrail()).toEqual([`delete ${kickedKey}`]);
  });

  it("should perform the same single delete for a userId that was never kicked", async () => {
    const { familyId, ownerToken } = await familyWithRemovedMember();
    const ops = watchKvOps(kv);

    expect((await clearKicked(familyId, STRANGER, ownerToken)).status).toBe(
      200,
    );

    // Identical KV footprint to the live-tombstone case above: the handler
    // cannot behave differently, because it never learns the difference.
    expect(ops.getKeys()).not.toContain(kvKeys.kicked(familyId, STRANGER));
    expect(ops.writeTrail()).toEqual([
      `delete ${kvKeys.kicked(familyId, STRANGER)}`,
    ]);
    // ...and the real ban, on a different uid, is untouched.
    expect(await readTombstone(familyId, KICKED)).not.toBeNull();
  });
});

// ===========================================================================
// Guards that run before anything is deleted
// ===========================================================================

/** Fails `^[a-z0-9]{4}-[a-z0-9]{4}$`, which the handler checks first. */
const MALFORMED_FAMILY_ID = "not-a-family-id";
/** Fails the strict 64-hex userId rule (`^[a-f0-9]{64}$`). */
const MALFORMED_USER_ID = "not-a-valid-user-id";
/** Well-formed, but no such family exists. */
const UNKNOWN_FAMILY_ID = "zzzz-9999";

interface GuardCase {
  label: string;
  pathFor: (familyId: string) => string;
  /** false = send no credentials at all. */
  authenticated: boolean;
  status: number;
  code: string;
}

const GUARD_CASES: GuardCase[] = [
  {
    label: "a malformed family id",
    pathFor: () => `/api/family/${MALFORMED_FAMILY_ID}/kicked/${KICKED}`,
    authenticated: true,
    status: 400,
    code: "INVALID_FAMILY_ID",
  },
  {
    label: "a malformed target user id",
    pathFor: (familyId) =>
      `/api/family/${familyId}/kicked/${MALFORMED_USER_ID}`,
    authenticated: true,
    status: 400,
    code: "INVALID_USER_ID",
  },
  {
    label: "a family that does not exist",
    pathFor: () => `/api/family/${UNKNOWN_FAMILY_ID}/kicked/${KICKED}`,
    authenticated: true,
    status: 404,
    code: "FAMILY_NOT_FOUND",
  },
  {
    label: "a caller with no credentials",
    pathFor: (familyId) => `/api/family/${familyId}/kicked/${KICKED}`,
    authenticated: false,
    status: 401,
    code: "UNAUTHORIZED",
  },
];

describe("DELETE /api/family/:id/kicked/:uid — input and auth guards", () => {
  it.each(GUARD_CASES)(
    "should refuse $label with $status $code and delete nothing",
    async ({ pathFor, authenticated, status, code }) => {
      const { familyId, ownerToken } = await familyWithRemovedMember();
      const ops = watchKvOps(kv);

      const res = await request(
        "DELETE",
        pathFor(familyId),
        undefined,
        authenticated ? ownerToken : undefined,
      );

      expect(res.status).toBe(status);
      expect(((await res.json()) as Json).error.code).toBe(code);
      // A refused call must not lift any ban — not the targeted one, not any
      // other. `deleteKeys` covers both at once.
      expect(ops.deleteKeys()).toEqual([]);
      expect(await readTombstone(familyId, KICKED)).not.toBeNull();
      expect((await join(familyId, KICKED)).status).toBe(403);
    },
  );
});

// ===========================================================================
// Shared per-userId write ceiling ("family-write", 30/hr)
//
// Un-kick joins the family-domain write handlers on ONE counter, charged to the
// AUTHENTICATED CALLER and never to the `:uid` path param — a counter keyed on
// someone else's id would be a victim-facing DoS lever. The charge sits after
// every zero-I/O guard (family-id format, 401, uid format) and before the first
// KV read, so the ownership 403 and the 404 — both of which need that read —
// land AFTER it and do cost a slot.
//
// Everything here runs WITHOUT DEV_MODE, which short-circuits the limiter;
// setup that must not spend the budget goes through `devRequest`.
// ===========================================================================

const { max: WRITE_MAX, windowSec: WRITE_WINDOW_SECONDS } = FAMILY_WRITE_LIMIT;

const WRITE_WINDOW_MS = WRITE_WINDOW_SECONDS * 1000;

/**
 * Exactly mid-window, so the counter cannot roll over mid-test and the back-off
 * hint is deterministic. Derived from the production window length rather than
 * hard-coded, so a changed window keeps the pin exact.
 */
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WRITE_WINDOW_MS) *
    WRITE_WINDOW_MS +
  WRITE_WINDOW_MS / 2;

/** Back-off the mid-window pin must produce: half the window, rounded up. */
const EXPECTED_RETRY_AFTER = Math.ceil(WRITE_WINDOW_SECONDS / 2);

const FAMILY_ID = "abcd-1234";
/**
 * A second removable member, so the shared-window case has a real target.
 *
 * Deliberately its OWN id rather than an alias of `STRANGER`: that constant is
 * documented as never joined and never removed, and the idempotency suite above
 * relies on exactly that. Seeding the same id as a member here would make one
 * constant carry two mutually exclusive roles.
 */
const EXTRA = OUTSIDER;

const OWNER_TOKEN = tokenFor(OWNER);
const MEMBER_TOKEN = tokenFor(MEMBER);

interface RequestOptions {
  token?: string;
}

async function buildRequest(
  method: string,
  path: string,
  opts: RequestOptions,
  env: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  return app.request(path, { method, headers }, env);
}

/** Live request: no DEV_MODE, so both limiters run. */
function prodRequest(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  return buildRequest(method, path, opts, { KV: kv });
}

/** DEV_MODE request: every limiter short-circuits — for setup only. */
function devRequest(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  return buildRequest(method, path, opts, { KV: kv, DEV_MODE: "1" });
}

const unkickPath = (familyId: string, uid: string) =>
  `/api/family/${familyId}/kicked/${uid}`;

/** Write a tombstone straight to KV, through the production key and TTL. */
async function seedTombstone(familyId: string, userId: string): Promise<void> {
  const record: KickedRecord = {
    removedAt: new Date().toISOString(),
    removedBy: OWNER,
  };
  await kv.put(kvKeys.kicked(familyId, userId), JSON.stringify(record), {
    expirationTtl: KICKED_TOMBSTONE_TTL_SECONDS,
  });
}

/**
 * The family the ceiling cases start from, written straight to KV rather than
 * through create/join: those two routes are deliberately OFF this ceiling, so
 * driving setup through them would blur what the assertions prove. Typed as the
 * production `FamilyRecord` and keyed through `kvKeys`, so a schema change
 * breaks compilation instead of seeding a dead key.
 */
async function seedFamilyWithBannedUser(): Promise<void> {
  const record: FamilyRecord = {
    familyId: FAMILY_ID,
    ownerId: OWNER,
    members: [
      { userId: OWNER, displayName: "Owner", canLend: BoolFlag.TRUE },
      { userId: MEMBER, displayName: "Member", canLend: BoolFlag.TRUE },
      { userId: EXTRA, displayName: "Extra", canLend: BoolFlag.TRUE },
    ],
    maxMembers: 4,
    createdAt: new Date().toISOString(),
  };
  await kv.put(kvKeys.family(FAMILY_ID), JSON.stringify(record));
  await Promise.all([
    kv.put(kvKeys.member(OWNER), FAMILY_ID),
    kv.put(kvKeys.member(MEMBER), FAMILY_ID),
    kv.put(kvKeys.member(EXTRA), FAMILY_ID),
    seedAuthToken(kv, OWNER),
    seedAuthToken(kv, MEMBER),
    seedAuthToken(kv, EXTRA),
    seedTombstone(FAMILY_ID, KICKED),
  ]);
}

/** Counter key of the caller's CURRENT window, via the production builder. */
async function writeCounterKey(userId: string): Promise<string> {
  const reading = await peekPerUserRateLimit(kv, {
    userId,
    ...FAMILY_WRITE_LIMIT,
  });
  return reading.key;
}

/** Family-domain writes charged to the account so far, or null if never charged. */
async function writesCharged(userId: string): Promise<number | null> {
  const raw = await kv.get(await writeCounterKey(userId));
  return raw === null ? null : parseInt(raw, 10);
}

/** Every family-write counter key currently in KV, whatever the userId. */
async function writeCounterKeys(): Promise<string[]> {
  const ownerKey = await writeCounterKey(OWNER);
  const prefix = ownerKey.slice(0, ownerKey.indexOf(OWNER));
  const { keys } = await kv.list();
  return keys.map((k) => k.name).filter((name) => name.startsWith(prefix));
}

/** Pre-spend `used` slots — far cheaper than driving 30 real requests. */
async function spendWriteBudget(userId: string, used: number): Promise<void> {
  await kv.put(await writeCounterKey(userId), String(used), {
    expirationTtl: WRITE_WINDOW_SECONDS * 2,
  });
}

describe("DELETE /api/family/:id/kicked/:uid — per-userId write ceiling", () => {
  beforeEach(async () => {
    // Pin Date (timers stay real) so the 1-hour window cannot roll over between
    // seeding the counter and the request under test.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
    await seedFamilyWithBannedUser();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges exactly one slot to the caller and keeps the counter self-expiring", async () => {
    const res = await prodRequest("DELETE", unkickPath(FAMILY_ID, KICKED), {
      token: OWNER_TOKEN,
    });

    expect(res.status).toBe(200);
    expect(await writesCharged(OWNER)).toBe(1);
    // Without a TTL the counter would live in KV forever.
    expect(getPutTtl(kv, await writeCounterKey(OWNER))).toBe(
      WRITE_WINDOW_SECONDS * 2,
    );
  });

  it("never charges the un-kicked target's own budget", async () => {
    await prodRequest("DELETE", unkickPath(FAMILY_ID, KICKED), {
      token: OWNER_TOKEN,
    });

    // Charging `:uid` would let an owner drain the budget of an account that is
    // not even in the family — the defect that got join's per-userId counter
    // removed. Exactly one counter exists, and it is the caller's.
    expect(await writesCharged(KICKED)).toBeNull();
    expect(await writeCounterKeys()).toEqual([await writeCounterKey(OWNER)]);
  });

  it("refuses with 429 once the shared window is spent, and lifts no ban", async () => {
    await spendWriteBudget(OWNER, WRITE_MAX);

    const res = await prodRequest("DELETE", unkickPath(FAMILY_ID, KICKED), {
      token: OWNER_TOKEN,
    });

    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.message).toBe(RATE_LIMITED_MESSAGE);
    // The pinned clock sits exactly mid-window, so the back-off hint is half the
    // window — which also pins the window length end to end.
    expect(json.error.retryAfter).toBe(EXPECTED_RETRY_AFTER);
    expect(res.headers.get("Retry-After")).toBe(String(json.error.retryAfter));
    // A refused write neither extends the window nor touches the tombstone.
    expect(await writesCharged(OWNER)).toBe(WRITE_MAX);
    expect(await readTombstone(FAMILY_ID, KICKED)).not.toBeNull();
  });

  it("counts un-kick against the same window as remove-member", async () => {
    await spendWriteBudget(OWNER, WRITE_MAX - 2);

    const removal = await prodRequest(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${EXTRA}`,
      { token: OWNER_TOKEN },
    );
    expect(removal.status).toBe(200);

    const unkick = await prodRequest("DELETE", unkickPath(FAMILY_ID, EXTRA), {
      token: OWNER_TOKEN,
    });
    expect(unkick.status).toBe(200);

    // Two different handlers, one counter — kicking and un-kicking in a loop
    // cannot cost less than any other pair of family-domain writes.
    expect(await writesCharged(OWNER)).toBe(WRITE_MAX);
    expect(await writeCounterKeys()).toHaveLength(1);

    const overCeiling = await prodRequest(
      "DELETE",
      unkickPath(FAMILY_ID, KICKED),
      { token: OWNER_TOKEN },
    );
    expect(overCeiling.status).toBe(429);
  });

  it("charges the caller even when it then refuses them as NOT_OWNER", async () => {
    // The ownership check needs a KV read, so it sits BELOW the charge site on
    // purpose: a rejected-request loop must not retry for free.
    const res = await prodRequest("DELETE", unkickPath(FAMILY_ID, KICKED), {
      token: MEMBER_TOKEN,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("NOT_OWNER");
    expect(await writesCharged(MEMBER)).toBe(1);
    expect(await writesCharged(OWNER)).toBeNull();
    expect(await readTombstone(FAMILY_ID, KICKED)).not.toBeNull();
  });

  it("charges the caller for a family that does not exist", async () => {
    const res = await prodRequest(
      "DELETE",
      unkickPath(UNKNOWN_FAMILY_ID, KICKED),
      { token: OWNER_TOKEN },
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as Json).error.code).toBe("FAMILY_NOT_FOUND");
    expect(await writesCharged(OWNER)).toBe(1);
  });

  it.each([
    {
      label: "an unauthenticated caller",
      path: () => unkickPath(FAMILY_ID, KICKED),
      token: undefined as string | undefined,
      status: 401,
      code: "UNAUTHORIZED",
    },
    {
      label: "a malformed family id",
      path: () => unkickPath(MALFORMED_FAMILY_ID, KICKED),
      token: OWNER_TOKEN,
      status: 400,
      code: "INVALID_FAMILY_ID",
    },
    {
      label: "a malformed target user id",
      path: () => unkickPath(FAMILY_ID, MALFORMED_USER_ID),
      token: OWNER_TOKEN,
      status: 400,
      code: "INVALID_USER_ID",
    },
  ])(
    "answers $label with $status without charging any account",
    async ({ path, token, status, code }) => {
      const res = await prodRequest("DELETE", path(), { token });

      expect(res.status).toBe(status);
      expect(((await res.json()) as Json).error.code).toBe(code);
      expect(await writeCounterKeys()).toHaveLength(0);
    },
  );

  it.each([
    {
      label: "an unauthenticated caller",
      path: () => unkickPath(FAMILY_ID, KICKED),
      token: undefined as string | undefined,
      status: 401,
      code: "UNAUTHORIZED",
    },
    {
      label: "a malformed family id",
      path: () => unkickPath(MALFORMED_FAMILY_ID, KICKED),
      token: OWNER_TOKEN,
      status: 400,
      code: "INVALID_FAMILY_ID",
    },
    {
      label: "a malformed target user id",
      path: () => unkickPath(FAMILY_ID, MALFORMED_USER_ID),
      token: OWNER_TOKEN,
      status: 400,
      code: "INVALID_USER_ID",
    },
  ])(
    "still answers $label with $status rather than 429 once the window is spent",
    async ({ path, token, status, code }) => {
      await spendWriteBudget(OWNER, WRITE_MAX);

      // A 429 where a 401 / 400 belongs would confirm the account exists and is
      // active to a caller who is not it.
      const res = await prodRequest("DELETE", path(), { token });

      expect(res.status).toBe(status);
      expect(((await res.json()) as Json).error.code).toBe(code);
      expect(await writesCharged(OWNER)).toBe(WRITE_MAX);
    },
  );

  it("does not apply the write ceiling in dev mode", async () => {
    await spendWriteBudget(OWNER, WRITE_MAX);

    // Local wrangler dev and E2E runs must not be throttled.
    const res = await devRequest("DELETE", unkickPath(FAMILY_ID, KICKED), {
      token: OWNER_TOKEN,
    });

    expect(res.status).toBe(200);
    // Dev mode neither reads nor charges the counter.
    expect(await writesCharged(OWNER)).toBe(WRITE_MAX);
    expect(await readTombstone(FAMILY_ID, KICKED)).toBeNull();
  });
});
