/**
 * A silent recovery join never admits a NEW member (#263).
 *
 * The bug: one token per userId, so a leave, an account deletion or a kick
 * revokes it; another device's stale session then answers 401 and the
 * client's silent recovery join re-listed the now-unlisted user as a new
 * member — undoing the departure (Inv-4). The fix is a join-side rule only:
 *
 * - `POST /api/family/:id/join` takes an optional `recovery` BoolFlag (absent
 *   ⇒ 0; anything but 0 / 1 ⇒ 400 INVALID_RECOVERY_FLAG before any KV op).
 * - After the verification gate and the kicked-tombstone gate, before the
 *   capacity check: an UNLISTED user with `recovery: 1` ⇒ 409
 *   RECOVERY_NOT_MEMBER, with no KV op of its own, no write, no time limit.
 * - A listed member's `recovery: 1` reconnect, and every manual join
 *   (`recovery` absent or 0), behave exactly as before.
 * - The departure paths write nothing new: their write trails are pinned
 *   exactly, so a marker-style key reappearing there fails loudly.
 *
 * Driven end-to-end over `app.request` against the Hono app + `createMockKV()`.
 * The mock never expires keys, so "the tombstone expired" is a delete, and
 * "time passed" moves only the faked `Date`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import { BoolFlag, kvKeys, type RawFamilyRecord } from "../../src/kv/schema";
import { USER1, USER2, USER3, USER4 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The store every assertion reads, and the one `watchKvOps` observes. */
let kv: KVNamespace;
/** What the app is handed as `env.KV` — `kv`, or a fault-injecting Proxy over it. */
let envKv: KVNamespace;

/** Production refusal copy (`routes/family.ts`), asserted only on real responses
 *  (test.md, "User-visible copy needs a production-anchored assertion"). */
const RECOVERY_NOT_MEMBER_MESSAGE = "你已經不是這個家庭的成員";

const CORRECT_PIN = "123456";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ----- Helpers -----

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
  return app.request(path, init, { KV: envKv, DEV_MODE: "1" });
}

async function createFamily(userId: string) {
  const res = await request("POST", "/api/family", { userId });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

function join(familyId: string, userId: string, extra?: object) {
  return request("POST", `/api/family/${familyId}/join`, {
    userId,
    ...extra,
  });
}

/** The client's silent recovery join after a 401. */
function recoveryJoin(familyId: string, userId: string, extra?: object) {
  return join(familyId, userId, { ...extra, recovery: BoolFlag.TRUE });
}

async function joinOk(familyId: string, userId: string): Promise<string> {
  const res = await join(familyId, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

/** USER1 owns the family, USER2 is the ordinary member who departs. */
async function createFamilyWithTwoMembers() {
  const { familyId, authToken: ownerToken } = await createFamily(USER1);
  const memberToken = await joinOk(familyId, USER2);
  return { familyId, ownerToken, memberToken };
}

function removeMember(familyId: string, targetUserId: string, token: string) {
  return request(
    "DELETE",
    `/api/family/${familyId}/member/${targetUserId}`,
    undefined,
    token,
  );
}

function deleteAccount(userId: string, token: string) {
  return request("DELETE", `/api/user/${userId}`, undefined, token);
}

/** USER2 leaves voluntarily; asserts the leave itself succeeded. */
async function leaveAsMember() {
  const ids = await createFamilyWithTwoMembers();
  const res = await removeMember(ids.familyId, USER2, ids.memberToken);
  expect(res.status).toBe(200);
  return ids;
}

/** Member userIds exactly as the stored family record lists them. */
async function listedMemberIds(familyId: string): Promise<string[]> {
  const record = await kv.get<RawFamilyRecord>(kvKeys.family(familyId), "json");
  expect(record).not.toBeNull();
  return record!.members.map((m) => m.userId);
}

/** Every key in the store, sorted — the whole observable KV state. */
async function allKeys(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys.map((k) => k.name).sort();
}

/** Sort a slice of a write trail so a parallel group compares as a SET. */
function asSet(entries: string[]): string[] {
  return [...entries].sort();
}

/** Set a real PIN through the production route, so hash + salt are genuine. */
async function setPin(userId: string, pin: string): Promise<void> {
  const token = await seedAuthToken(kv, userId);
  const res = await request(
    "PUT",
    `/api/user/${userId}/verify`,
    { method: "pin", secret: pin },
    token,
  );
  expect(res.status).toBe(200);
}

async function expectRecoveryNotMember(res: Response): Promise<void> {
  expect(res.status).toBe(409);
  const json = (await res.json()) as Json;
  expect(json.error.code).toBe("RECOVERY_NOT_MEMBER");
  expect(json.error.message).toBe(RECOVERY_NOT_MEMBER_MESSAGE);
  expect(json.data).toBeUndefined();
}

async function expectErrorCode(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(res.status).toBe(status);
  expect(((await res.json()) as Json).error.code).toBe(code);
}

async function expectAdmittedWithToken(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const token = ((await res.json()) as Json).data.authToken as string;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  return token;
}

/** Make every `op` on `failingKey` throw ONCE, all else passing through to `kv`; a
 *  Proxy, so a later `watchKvOps(kv)` still sees every write that landed. */
function failNextKvOp(op: "put" | "delete", failingKey: string) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let fired = false;
  envKv = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === op) {
        return async (key: string, ...rest: unknown[]): Promise<unknown> => {
          if (!fired && key === failingKey) {
            fired = true;
            throw new Error(`simulated KV ${op} failure for "${key}"`);
          }
          const real = Reflect.get(target, op) as (
            k: string,
            ...r: unknown[]
          ) => Promise<unknown>;
          return real(key, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { fired: () => fired };
}

/** Let KV ops orphaned by a rejected `Promise.all` finish (microtask-only mock). */
function settleOrphanedKvOps(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  kv = createMockKV();
  envKv = kv;
});

afterEach(() => {
  // watchKvOps / console silencers install spies that do not clean up, and
  // the "no time limit" cases fake Date.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ===== Regression: the issue's own scenario =====

describe("POST /api/family/:id/join recovery after a self-leave (#263 regression)", () => {
  it("should refuse the leaver's recovery join with 409 RECOVERY_NOT_MEMBER and write nothing", async () => {
    const { familyId, ownerToken } = await leaveAsMember();
    const keysAfterLeave = await allKeys();
    const ops = watchKvOps(kv);

    const res = await recoveryJoin(familyId, USER2);

    await expectRecoveryNotMember(res);
    // Refused with no side effect: not re-listed, no pointer, no session minted.
    expect(ops.writeTrail()).toEqual([]);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER2))).toBeNull();
    expect(await allKeys()).toEqual(keysAfterLeave);
    // Positive companion for "no token": the store's only token is the owner's.
    expect(keysAfterLeave).toContain(kvKeys.authToken(ownerToken));

    // The refusal consumes nothing: a retry is refused the same way.
    await expectRecoveryNotMember(await recoveryJoin(familyId, USER2));
    expect(ops.writeTrail()).toEqual([]);
    expect(await allKeys()).toEqual(keysAfterLeave);
  });

  it.each([
    {
      label: "7 hours (past the 6-hour kick tombstone)",
      advanceMs: 7 * HOUR_MS,
    },
    { label: "100 days", advanceMs: 100 * DAY_MS },
  ])(
    "should still refuse the recovery join $label after the leave (no time limit)",
    async ({ advanceMs }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { familyId } = await leaveAsMember();
      vi.setSystemTime(Date.now() + advanceMs);
      const ops = watchKvOps(kv);

      await expectRecoveryNotMember(await recoveryJoin(familyId, USER2));

      expect(ops.writeTrail()).toEqual([]);
      expect(await listedMemberIds(familyId)).toEqual([USER1]);
      expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    },
  );

  it("should refuse the recovery join after an account deletion (listed non-owner, multi-member)", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    expect((await deleteAccount(USER2, memberToken)).status).toBe(200);
    const ops = watchKvOps(kv);

    await expectRecoveryNotMember(await recoveryJoin(familyId, USER2));

    expect(ops.writeTrail()).toEqual([]);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER2))).toBeNull();
  });

  it("should refuse a half-failed self-leave's recovery join and leave the stray pointer inert", async () => {
    // familyPartialWrite.test.ts covers the unflagged rejoin from this state;
    // this is the flagged one an updated client sends after its 401.
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    const fault = failNextKvOp("delete", kvKeys.member(USER2));
    expect((await removeMember(familyId, USER2, memberToken)).status).toBe(500);
    expect(fault.fired()).toBe(true);
    await settleOrphanedKvOps();
    envKv = kv;
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect((await removeMember(familyId, USER2, memberToken)).status).toBe(401);
    const ops = watchKvOps(kv);

    // The stray pointer names THIS family, so no ALREADY_IN_FAMILY; unlisted,
    // so the recovery is refused rather than re-listing them.
    await expectRecoveryNotMember(await recoveryJoin(familyId, USER2));
    expect(ops.writeTrail()).toEqual([]);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.auth(USER2))).toBeNull();

    // A manual join still works from this state.
    await expectAdmittedWithToken(await join(familyId, USER2));
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
  });
});

// ===== The departures themselves are unchanged =====

describe("Departure write trails carry no recovery bookkeeping", () => {
  it("should write exactly the family put, then the revoke, on a self-leave", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    expect((await removeMember(familyId, USER2, memberToken)).status).toBe(200);

    const trail = ops.writeTrail();
    expect(trail[0]).toBe(`put ${kvKeys.family(familyId)}`);
    expect(asSet(trail.slice(1))).toEqual(
      asSet([
        `delete ${kvKeys.member(USER2)}`,
        `delete ${kvKeys.auth(USER2)}`,
        `delete ${kvKeys.authToken(memberToken)}`,
      ]),
    );
    // And nothing else lives in the store: the owner's session and the family.
    expect(await allKeys()).toEqual(
      asSet([
        kvKeys.family(familyId),
        kvKeys.member(USER1),
        kvKeys.auth(USER1),
        kvKeys.authToken(ownerToken),
      ]),
    );
  });

  it("should write exactly the family put, then the account teardown, on an account deletion", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    expect((await deleteAccount(USER2, memberToken)).status).toBe(200);

    const trail = ops.writeTrail();
    expect(trail[0]).toBe(`put ${kvKeys.family(familyId)}`);
    expect(asSet(trail.slice(1))).toEqual(
      asSet([
        `delete ${kvKeys.user(USER2)}`,
        `delete ${kvKeys.publicShelves(USER2)}`,
        `delete ${kvKeys.member(USER2)}`,
        `delete ${kvKeys.auth(USER2)}`,
        `delete ${kvKeys.authToken(memberToken)}`,
      ]),
    );
    expect(await allKeys()).toEqual(
      asSet([
        kvKeys.family(familyId),
        kvKeys.member(USER1),
        kvKeys.auth(USER1),
        kvKeys.authToken(ownerToken),
      ]),
    );
  });
});

// ===== Owner kick: the tombstone gate answers first =====

describe("POST /api/family/:id/join recovery after an owner kick", () => {
  it("should answer MEMBER_REMOVED while the tombstone lives, then RECOVERY_NOT_MEMBER, while a manual join is admitted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    expect((await removeMember(familyId, USER2, ownerToken)).status).toBe(200);
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).not.toBeNull();

    await expectErrorCode(
      await recoveryJoin(familyId, USER2),
      403,
      "MEMBER_REMOVED",
    );

    // Past the 6h TTL; the mock never expires keys, so retire it by hand.
    vi.setSystemTime(Date.now() + 7 * HOUR_MS);
    await kv.delete(kvKeys.kicked(familyId, USER2));
    const ops = watchKvOps(kv);

    await expectRecoveryNotMember(await recoveryJoin(familyId, USER2));
    expect(ops.writeTrail()).toEqual([]);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);

    await expectAdmittedWithToken(await join(familyId, USER2));
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
  });
});

// ===== Unlisted users in general =====

describe("POST /api/family/:id/join recovery by an unlisted user", () => {
  it("should refuse a user who was never a member", async () => {
    const { familyId } = await createFamily(USER1);
    const ops = watchKvOps(kv);

    await expectRecoveryNotMember(await recoveryJoin(familyId, USER2));

    expect(ops.writeTrail()).toEqual([]);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
  });

  it("should answer RECOVERY_NOT_MEMBER, not FAMILY_FULL, for a full family", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    await expectRecoveryNotMember(await recoveryJoin(familyId, USER3));

    // Control: the same user's MANUAL join reaches the capacity check.
    await expectErrorCode(await join(familyId, USER3), 409, "FAMILY_FULL");
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
  });

  it("should still answer ALREADY_IN_FAMILY for a live membership elsewhere", async () => {
    const { familyId } = await leaveAsMember();
    await createFamily(USER2);

    await expectErrorCode(
      await recoveryJoin(familyId, USER2),
      409,
      "ALREADY_IN_FAMILY",
    );
  });

  it("should still answer FAMILY_NOT_FOUND for a dissolved family", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    expect((await removeMember(familyId, USER1, authToken)).status).toBe(200);
    expect(await kv.get(kvKeys.family(familyId))).toBeNull();

    await expectErrorCode(
      await recoveryJoin(familyId, USER2),
      404,
      "FAMILY_NOT_FOUND",
    );
  });

  it("should touch no key beyond a manual join's own reads up to that point", async () => {
    const { familyId } = await leaveAsMember();
    const ops = watchKvOps(kv);

    await expectRecoveryNotMember(await recoveryJoin(familyId, USER2));
    const refusalGets = ops.getKeys();
    expect(ops.writeTrail()).toEqual([]);
    vi.restoreAllMocks();

    const manualOps = watchKvOps(kv);
    await expectAdmittedWithToken(await join(familyId, USER2));
    const manualGets = manualOps.getKeys();

    // The refusal reads the same keys, in the same order, as the manual join
    // up to its capacity check: the rule itself costs no KV op.
    expect(asSet(refusalGets)).toEqual(
      asSet([
        kvKeys.member(USER2),
        kvKeys.family(familyId),
        kvKeys.verify(USER2),
        kvKeys.kicked(familyId, USER2),
      ]),
    );
    expect(manualGets.slice(0, refusalGets.length)).toEqual(refusalGets);
    // Positive companion for the empty write trail: the admission DOES write.
    expect(manualOps.writeTrail()).toContain(`put ${kvKeys.family(familyId)}`);
  });
});

// ===== Manual joins and listed reconnects are unaffected =====

describe("POST /api/family/:id/join manual joins and listed reconnects", () => {
  it.each([
    { label: "recovery absent", extra: {} },
    { label: "recovery: 0", extra: { recovery: BoolFlag.FALSE } },
  ])(
    "should admit a manual join after a leave ($label), then that member's recovery reconnect",
    async ({ extra }) => {
      const { familyId } = await leaveAsMember();

      await expectAdmittedWithToken(await join(familyId, USER2, extra));
      expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
      expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);

      // Listed again: the recovery reconnect is admitted with a session.
      await expectAdmittedWithToken(await recoveryJoin(familyId, USER2));
      expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    },
  );

  it("should admit a listed member's recovery reconnect with a token", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const token = await expectAdmittedWithToken(
      await recoveryJoin(familyId, USER2),
    );

    expect(await kv.get(kvKeys.authToken(token))).toBe(USER2);
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
  });

  it("should admit and heal a listed member whose pointer is missing", async () => {
    const { familyId } = await createFamilyWithTwoMembers();
    await kv.delete(kvKeys.member(USER2));

    await expectAdmittedWithToken(await recoveryJoin(familyId, USER2));

    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
  });
});

// ===== Verification gate ordering =====

describe("POST /api/family/:id/join recovery vs the verification gate", () => {
  it("should answer the verification error, identically for listed and unlisted users", async () => {
    await setPin(USER2, CORRECT_PIN);
    await setPin(USER3, CORRECT_PIN);
    const { familyId } = await createFamily(USER1);
    await expectAdmittedWithToken(
      await join(familyId, USER2, { verifySecret: CORRECT_PIN }),
    );
    const ops = watchKvOps(kv);

    const unlisted = await recoveryJoin(familyId, USER3);
    const listed = await recoveryJoin(familyId, USER2);

    // Membership is not disclosed before the account's own gate.
    expect(unlisted.status).toBe(403);
    const unlistedJson = (await unlisted.json()) as Json;
    expect(unlistedJson.error.code).toBe("VERIFICATION_REQUIRED");
    expect(listed.status).toBe(unlisted.status);
    expect(((await listed.json()) as Json).error).toEqual(unlistedJson.error);
    // Nothing past the gate was even read.
    expect(ops.getKeys()).not.toContain(kvKeys.kicked(familyId, USER3));
    expect(ops.getKeys()).toContain(kvKeys.verify(USER3));
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
  });

  it("should answer RECOVERY_NOT_MEMBER to an unlisted user with the correct secret", async () => {
    await setPin(USER2, CORRECT_PIN);
    const { familyId } = await createFamily(USER1);

    await expectRecoveryNotMember(
      await recoveryJoin(familyId, USER2, { verifySecret: CORRECT_PIN }),
    );

    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
  });

  it("should admit an unlisted user's correct-secret join without recovery (a manual join)", async () => {
    await setPin(USER2, CORRECT_PIN);
    const { familyId } = await createFamily(USER1);

    await expectAdmittedWithToken(
      await join(familyId, USER2, { verifySecret: CORRECT_PIN }),
    );

    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
  });
});

// ===== `recovery` boundary validation =====

describe("POST /api/family/:id/join recovery flag validation", () => {
  it.each([
    { label: "absent", extra: {}, status: 200 },
    { label: "0", extra: { recovery: 0 }, status: 200 },
    // Well-formed: refused by the membership rule, not by the format check.
    { label: "1", extra: { recovery: 1 }, status: 409 },
  ])(
    "should accept recovery $label as well-formed",
    async ({ extra, status }) => {
      const { familyId } = await createFamily(USER1);

      const res = await join(familyId, USER2, extra);

      expect(res.status).toBe(status);
      if (status !== 200) {
        expect(((await res.json()) as Json).error.code).toBe(
          "RECOVERY_NOT_MEMBER",
        );
      }
    },
  );

  it.each([
    { label: "null", value: null },
    { label: "true", value: true },
    { label: 'the string "1"', value: "1" },
    { label: "2", value: 2 },
  ])(
    "should reject recovery $label with 400 INVALID_RECOVERY_FLAG before any KV op",
    async ({ value }) => {
      const { familyId } = await createFamily(USER1);
      // USER4 already lives in another family: still a 400, never ALREADY_IN_FAMILY.
      await createFamily(USER4);
      const ops = watchKvOps(kv);

      const res = await join(familyId, USER4, { recovery: value });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("INVALID_RECOVERY_FLAG");
      expect(json.error.message).toBe("recovery must be 0 or 1");
      expect(ops.getKeys()).toEqual([]);
      expect(ops.writeTrail()).toEqual([]);
    },
  );
});
