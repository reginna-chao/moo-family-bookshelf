/**
 * A `member:{uid}` pointer is NOT membership on its own (#213, Fix Cycle 1).
 *
 * A STALE pointer names a live family whose record no longer lists the user.
 * It comes from a stale pointer read at the removal site (KV ~60s
 * propagation), a reconnect that healed the pointer during a kick whose
 * tombstone put failed open, or a pre-#213 half-failed removal.
 *
 * It USED to come from a same-colo race too: with a tombstone written LAST, a
 * kicked member's auto-join landing between the owner's revoke deletes and the
 * owner's `family:{id}` put saw itself still listed, healed the pointer and
 * minted a token — and a second, renaming reconnect could then write the stale
 * list back over the owner's put: a full re-admission. Owner kicks now write
 * the tombstone FIRST (Fix Cycle 3), and the join reads the pointer before it
 * checks the tombstone, so any join that could heal is refused with 403
 * MEMBER_REMOVED instead. The first describe pins that closure. Ordering alone
 * does not cover a target who was ALREADY pointerless, or a brand-new member:
 * their join can pass the tombstone gate before the owner's tombstone lands and
 * write the pointer after the owner's pointer read. The join therefore re-reads
 * the tombstone after its pointer put and retracts the pointer (Fix Cycle 4,
 * `retractPointerIfKicked`); the second describe pins that. The rules below
 * are driven from directly-seeded state, because they must keep holding for
 * the stale pointers that the remaining sources still produce.
 *
 * What must hold for such a pointer, one describe per rule:
 *
 * - (A) `GET /bookshelf` and `GET /members` re-check the record and answer the
 *   same 404 as a pointer mismatch.
 * - (B) The remove-member `MEMBER_NOT_FOUND` branch deletes a stray pointer
 *   (and the token) that names THIS family — owner re-kick or self-target — and
 *   leaves a pointer naming another family alone.
 * - (C) create / join treat it as no membership (`isLiveMembership`).
 * - (D) `POST /api/auth/lookup` reports the no-family shape for it.
 * - (E) A pointer-healing reconnect never writes `family:{id}` back — not even
 *   for a changed displayName (Fix Cycle 2; defence in depth since Fix Cycle 3,
 *   for a heal that slips past a failed-open tombstone).
 *
 * Every case drives the real Hono app over `app.request` with a
 * `createMockKV()` store (TTL floor intact). The races are reproduced
 * deterministically by running the target's join(s) from inside one of the
 * owner's writes, before that write reaches the store. Every wait inside such
 * a hook is a `Promise.race` against "the join reached a `family:{id}` put",
 * so a join that blocks there can never deadlock the owner's request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import { BoolFlag, kvKeys, type AuthRecord } from "../../src/kv/schema";
import { USER1, USER2, USER3, USER4 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The store every assertion reads. */
let kv: KVNamespace;
/** What the app is handed as `env.KV`: `kv`, or an interleaving Proxy over it. */
let envKv: KVNamespace;

/** `"user:"` from the production key builder, for the fan-out read checks. */
const USER_KEY_PREFIX = kvKeys.user("");

// ---------------------------------------------------------------------------
// Helpers
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

function join(familyId: string, userId: string, displayName?: string) {
  return request("POST", `/api/family/${familyId}/join`, {
    userId,
    displayName,
  });
}

/** USER1 owns the family, USER2 is an ordinary member. */
async function createFamilyWithTwoMembers() {
  const { familyId, authToken: ownerToken } = await createFamily(USER1);
  const res = await join(familyId, USER2);
  expect(res.status).toBe(200);
  const memberToken = ((await res.json()) as Json).data.authToken as string;
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

function getMembers(familyId: string, token: string) {
  return request("GET", `/api/family/${familyId}/members`, undefined, token);
}

function getBookshelf(familyId: string, token: string) {
  return request("GET", `/api/family/${familyId}/bookshelf`, undefined, token);
}

function lookup(userId: string) {
  return request("POST", "/api/auth/lookup", { userId });
}

async function listedMemberIds(familyId: string): Promise<string[]> {
  const record = await kv.get<{ members: { userId: string }[] }>(
    kvKeys.family(familyId),
    "json",
  );
  expect(record).not.toBeNull();
  return record!.members.map((m) => m.userId);
}

async function displayNameOf(
  familyId: string,
  userId: string,
): Promise<string | undefined> {
  const record = await kv.get<{
    members: { userId: string; displayName: string }[];
  }>(kvKeys.family(familyId), "json");
  return record?.members.find((m) => m.userId === userId)?.displayName;
}

function readAuthRecord(userId: string) {
  return kv.get<AuthRecord>(kvKeys.auth(userId), "json");
}

async function expectErrorCode(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as Json).error.code).toBe(code);
}

/**
 * Put `userId` into the stale-pointer state directly: a valid token and a
 * `member:{uid}` naming `familyId`, whose record does not list them. Returns
 * the token.
 */
async function seedStalePointer(
  userId: string,
  familyId: string,
): Promise<string> {
  expect(await listedMemberIds(familyId)).not.toContain(userId);
  const token = await seedAuthToken(kv, userId);
  await kv.put(kvKeys.member(userId), familyId);
  return token;
}

type KvWriteOp = "put" | "delete";

/**
 * Run `hook` once, immediately BEFORE the next `op` on `key` reaches the
 * store. The hook's own requests go through the same (now disarmed) Proxy.
 * Callers MUST assert `fired()`, or a handler that stopped writing `key` would
 * pass every "after the race" assertion vacuously.
 */
function runBeforeNext(op: KvWriteOp, key: string, hook: () => Promise<void>) {
  let armed = true;
  let fired = false;
  envKv = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === op) {
        return async (k: string, ...rest: unknown[]): Promise<unknown> => {
          if (armed && k === key) {
            armed = false;
            await hook();
            fired = true;
          }
          const real = Reflect.get(target, op) as (
            k: string,
            ...r: unknown[]
          ) => Promise<unknown>;
          return real(k, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { fired: () => fired };
}

/**
 * Kick USER2 while ONE plain reconnect join by USER2 (no displayName) runs to
 * completion immediately before the owner's `op` on `key`. Returns both
 * responses; the caller asserts on the join's.
 */
async function kickWithReconnectBefore(
  familyId: string,
  ownerToken: string,
  op: KvWriteOp,
  key: string,
) {
  const raceJoin: { res?: Response } = {};
  const race = runBeforeNext(op, key, async () => {
    raceJoin.res = await join(familyId, USER2);
  });

  const kick = await removeMember(familyId, USER2, ownerToken);

  expect(race.fired()).toBe(true);
  envKv = kv;
  expect(raceJoin.res).toBeDefined();
  return { kick, raceJoin: raceJoin.res! };
}

/**
 * Worst-case interleaving (#213, Fix Cycles 2 and 3): kick USER2 while USER2's
 * reconnect joins start one after another from inside the owner's `family:{id}`
 * put — i.e. after the owner's revoke deletes — each carrying the listed
 * displayName (`undefined` = none sent).
 *
 * The owner's put is held back until each join has either finished or reached
 * a `family:{id}` put of its own; any family put a join makes is then held
 * until the owner's put has landed. A stale-record write-back from a join — a
 * lost update over the owner's removal — is exactly what this surfaces. Every
 * wait is a `Promise.race` against "the join reached its put", so a join that
 * blocks there cannot deadlock the owner's request.
 *
 * With `[undefined, "Renamed"]` this is the reviewer's two-request race: J_a
 * (no displayName) would HEAL the revoked pointer, which turns J_b into a
 * NON-healing reconnect whose displayName change writes the stale list — still
 * listing USER2 — back after the owner's put: listed + pointer + token.
 */
async function kickWithReconnectsInsideFamilyPut(
  familyId: string,
  ownerToken: string,
  displayNames: (string | undefined)[],
) {
  const familyKey = kvKeys.family(familyId);
  let ownerPutArmed = true;
  const joins: Promise<Response>[] = [];
  let signalJoinReachedPut: (() => void) | undefined;
  const nextJoinReachedPut = () =>
    new Promise<void>((r) => (signalJoinReachedPut = r));
  let signalOwnerPutLanded!: () => void;
  const ownerPutLanded = new Promise<void>((r) => (signalOwnerPutLanded = r));

  envKv = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "put") {
        const real = Reflect.get(target, "put") as (
          k: string,
          ...r: unknown[]
        ) => Promise<unknown>;
        return async (k: string, ...rest: unknown[]): Promise<unknown> => {
          if (k !== familyKey) return real(k, ...rest);
          if (ownerPutArmed) {
            // The owner's removal put: its revoke deletes have already run.
            ownerPutArmed = false;
            for (const displayName of displayNames) {
              const reached = nextJoinReachedPut();
              const joinRes = Promise.resolve(
                join(familyId, USER2, displayName),
              );
              joins.push(joinRes);
              await Promise.race([joinRes, reached]);
            }
            await real(k, ...rest);
            signalOwnerPutLanded();
            return;
          }
          // A family put from a racing join: land it AFTER the owner's.
          signalJoinReachedPut?.();
          await ownerPutLanded;
          return real(k, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const kick = await removeMember(familyId, USER2, ownerToken);

  const joinResponses = await Promise.all(joins);
  envKv = kv;
  expect(joinResponses).toHaveLength(displayNames.length);
  return { kick, joins: joinResponses };
}

/**
 * The pointerless-heal straddle (#213, Fix Cycle 4): kick USER2 — listed but
 * already pointerless — while ONE plain reconnect J_a straddles the owner's
 * tombstone:
 *
 * 1. J_a starts from inside the owner's `kicked:` put, i.e. BEFORE it lands,
 *    and runs until its heal `member:` put, which is held. J_a's tombstone gate
 *    read therefore saw no tombstone.
 * 2. The owner's tombstone put lands, then its target-pointer read sees null
 *    and deletes nothing.
 * 3. At the owner's `family:` put — after that pointer read — the heal put is
 *    released and J_a runs to completion; only then does the owner's put land.
 *
 * Ordering alone let that heal survive (pointer back, token minted); only the
 * join's post-put tombstone re-check catches it.
 */
async function kickWithHealStraddlingTombstone(
  familyId: string,
  ownerToken: string,
) {
  const tombstoneKey = kvKeys.kicked(familyId, USER2);
  const pointerKey = kvKeys.member(USER2);
  const familyKey = kvKeys.family(familyId);
  let phase: "armed" | "holdingHeal" | "released" = "armed";
  let joinRes: Promise<Response> | undefined;
  let healReached = false;
  let signalHealReached!: () => void;
  const healReachedP = new Promise<void>((r) => (signalHealReached = r));
  let releaseHeal!: () => void;
  const healReleased = new Promise<void>((r) => (releaseHeal = r));

  envKv = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "put") {
        const real = Reflect.get(target, "put") as (
          k: string,
          ...r: unknown[]
        ) => Promise<unknown>;
        return async (k: string, ...rest: unknown[]): Promise<unknown> => {
          if (phase === "armed" && k === tombstoneKey) {
            // (1) The owner's tombstone put, not yet landed.
            phase = "holdingHeal";
            joinRes = Promise.resolve(join(familyId, USER2));
            await Promise.race([healReachedP, joinRes]);
            return real(k, ...rest);
          }
          if (phase === "holdingHeal" && k === pointerKey) {
            // J_a's heal put: hold it past the owner's pointer read.
            healReached = true;
            signalHealReached();
            await healReleased;
            return real(k, ...rest);
          }
          if (phase === "holdingHeal" && k === familyKey) {
            // (3) The owner's list put: its pointer read is behind it.
            phase = "released";
            releaseHeal();
            await joinRes;
            return real(k, ...rest);
          }
          return real(k, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const kick = await removeMember(familyId, USER2, ownerToken);
  // Never leave J_a parked if the kick bailed out before its list put.
  releaseHeal();
  envKv = kv;

  expect(healReached).toBe(true);
  expect(phase).toBe("released");
  expect(joinRes).toBeDefined();
  return { kick, raceJoin: await joinRes! };
}

/**
 * The closed-race end state: the kick stuck. USER2 is unlisted, has neither a
 * pointer nor a session, the ban is in place, and the token USER2 held before
 * the kick reads nothing. `ops` must have been watching since before the kick:
 * no request in the race may have written USER2's pointer or auth record.
 */
async function expectKickStuck(
  familyId: string,
  memberToken: string,
  ops: ReturnType<typeof watchKvOps>,
) {
  expect(await listedMemberIds(familyId)).toEqual([USER1]);
  expect(await kv.get(kvKeys.member(USER2))).toBeNull();
  expect(await readAuthRecord(USER2)).toBeNull();
  expect(await kv.get(kvKeys.kicked(familyId, USER2))).not.toBeNull();
  // No heal, no minted token — from the kick or from any racing join.
  expect(ops.putKeys()).not.toContain(kvKeys.member(USER2));
  expect(ops.putKeys()).not.toContain(kvKeys.auth(USER2));
  // Positive companion: the watch saw the kick's own writes.
  expect(ops.putKeys()).toContain(kvKeys.kicked(familyId, USER2));
  expect(ops.putKeys()).toContain(kvKeys.family(familyId));
  // The session USER2 held before the kick is dead.
  expect((await getBookshelf(familyId, memberToken)).status).toBe(401);
  expect((await getMembers(familyId, memberToken)).status).toBe(401);
}

beforeEach(() => {
  kv = createMockKV();
  envKv = kv;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// The race itself
// ===========================================================================

describe("Kick racing the kicked member's reconnect", () => {
  it.each([
    {
      label: "after the tombstone, before the pointer revoke",
      op: "delete" as const,
      keyFor: () => kvKeys.member(USER2),
    },
    {
      label: "after the pointer revoke, before the member-list put",
      op: "put" as const,
      keyFor: (familyId: string) => kvKeys.family(familyId),
    },
  ])(
    "should refuse a reconnect landing $label with 403 MEMBER_REMOVED",
    async ({ op, keyFor }) => {
      const { familyId, ownerToken, memberToken } =
        await createFamilyWithTwoMembers();
      const ops = watchKvOps(kv);

      const { kick, raceJoin } = await kickWithReconnectBefore(
        familyId,
        ownerToken,
        op,
        keyFor(familyId),
      );

      expect(kick.status).toBe(200);
      // The second window is the one tombstone-last left open: the join saw
      // the pointer gone and itself still listed, and healed the pointer.
      await expectErrorCode(raceJoin, 403, "MEMBER_REMOVED");
      await expectKickStuck(familyId, memberToken, ops);
    },
  );

  it("should not re-list the kicked member when the racing reconnect carries a new displayName", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    expect(await displayNameOf(familyId, USER2)).not.toBe("Renamed");
    const ops = watchKvOps(kv);

    const { kick, joins } = await kickWithReconnectsInsideFamilyPut(
      familyId,
      ownerToken,
      ["Renamed"],
    );

    expect(kick.status).toBe(200);
    await expectErrorCode(joins[0], 403, "MEMBER_REMOVED");
    await expectKickStuck(familyId, memberToken, ops);
  });

  it("should not re-admit the kicked member through a healing reconnect followed by a renaming one", async () => {
    // The reviewer's two-request race (Fix Cycle 3). Under tombstone-last,
    // J_a healed the pointer inside the revoke → list-put gap, J_b then saw
    // the healed pointer, took the NON-healing branch and wrote its stale
    // list (still listing USER2, now "Renamed") back after the owner's put —
    // listed + pointer + token: a full re-admission with bookshelf access.
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    const { kick, joins } = await kickWithReconnectsInsideFamilyPut(
      familyId,
      ownerToken,
      [undefined, "Renamed"],
    );

    expect(kick.status).toBe(200);
    const [joinA, joinB] = joins;
    await expectErrorCode(joinA, 403, "MEMBER_REMOVED");
    await expectErrorCode(joinB, 403, "MEMBER_REMOVED");
    await expectKickStuck(familyId, memberToken, ops);
    // Exactly one family put landed — the owner's — so nothing wrote the
    // stale list back over it.
    expect(
      ops.putKeys().filter((k) => k === kvKeys.family(familyId)),
    ).toHaveLength(1);
  });
});

// ===========================================================================
// The join re-checks the tombstone after its own pointer put
// ===========================================================================

describe("POST /api/family/:id/join tombstone re-check after the pointer put", () => {
  /** `"token:"` from the production key builder: no session may be minted. */
  const TOKEN_KEY_PREFIX = kvKeys.authToken("");

  it("should retract a heal whose pointer put lands after the kick's pointer read, for an already-pointerless member", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    // Pre-existing half-state: listed, no pointer, no session — an earlier
    // self-leave that failed after its revoke, or a join whose pointer put
    // failed after its record put.
    await Promise.all([
      kv.delete(kvKeys.member(USER2)),
      kv.delete(kvKeys.auth(USER2)),
      kv.delete(kvKeys.authToken(memberToken)),
    ]);
    const ops = watchKvOps(kv);

    const { kick, raceJoin } = await kickWithHealStraddlingTombstone(
      familyId,
      ownerToken,
    );

    expect(kick.status).toBe(200);
    await expectErrorCode(raceJoin, 403, "MEMBER_REMOVED");
    // The interleaving really happened: J_a's heal put landed AFTER the
    // tombstone, and J_a retracted it before the owner's list put.
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.kicked(familyId, USER2)}`,
      `put ${kvKeys.member(USER2)}`,
      `delete ${kvKeys.member(USER2)}`,
      `put ${kvKeys.family(familyId)}`,
    ]);
    // End state: the kick stuck.
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await readAuthRecord(USER2)).toBeNull();
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).not.toBeNull();
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    // No session minted for the target by the join.
    expect(ops.putKeys()).not.toContain(kvKeys.auth(USER2));
    expect(ops.putKeys().filter((k) => k.startsWith(TOKEN_KEY_PREFIX))).toEqual(
      [],
    );
  });

  it("should retract a new member's pointer when a kick lands between the tombstone gate and the pointer put", async () => {
    const { familyId, authToken: ownerToken } = await createFamily(USER1);
    const ops = watchKvOps(kv);

    // The owner sees the join's record put and kicks before its pointer put:
    // the kick's pointer read finds nothing to delete.
    const raceKick: { res?: Response } = {};
    const race = runBeforeNext("put", kvKeys.member(USER3), async () => {
      raceKick.res = await removeMember(familyId, USER3, ownerToken);
    });

    const res = await join(familyId, USER3);

    expect(race.fired()).toBe(true);
    envKv = kv;
    expect(raceKick.res?.status).toBe(200);
    await expectErrorCode(res, 403, "MEMBER_REMOVED");
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.family(familyId)}`,
      `put ${kvKeys.kicked(familyId, USER3)}`,
      `put ${kvKeys.family(familyId)}`,
      `put ${kvKeys.member(USER3)}`,
      `delete ${kvKeys.member(USER3)}`,
    ]);
    expect(await kv.get(kvKeys.member(USER3))).toBeNull();
    expect(await readAuthRecord(USER3)).toBeNull();
    expect(await kv.get(kvKeys.kicked(familyId, USER3))).not.toBeNull();
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(ops.putKeys()).not.toContain(kvKeys.auth(USER3));
    expect(ops.putKeys().filter((k) => k.startsWith(TOKEN_KEY_PREFIX))).toEqual(
      [],
    );
  });

  it.each([
    {
      label: "a pointer-healing reconnect",
      userId: USER2,
      setup: async () => {
        const { familyId } = await createFamilyWithTwoMembers();
        await kv.delete(kvKeys.member(USER2));
        return familyId;
      },
      kickedReads: 2,
    },
    {
      label: "a new-member join",
      userId: USER3,
      setup: async () => (await createFamily(USER1)).familyId,
      kickedReads: 2,
    },
    {
      label: "a non-healing reconnect (no pointer put, no re-check)",
      userId: USER2,
      setup: async () => (await createFamilyWithTwoMembers()).familyId,
      kickedReads: 1,
    },
  ])(
    "should admit $label with no tombstone and read the tombstone $kickedReads time(s) (positive companion)",
    async ({ userId, setup, kickedReads }) => {
      const familyId = await setup();
      const ops = watchKvOps(kv);

      const res = await join(familyId, userId);

      expect(res.status).toBe(200);
      const token = ((await res.json()) as Json).data.authToken as string;
      expect(await kv.get(kvKeys.member(userId))).toBe(familyId);
      expect(ops.deleteKeys()).not.toContain(kvKeys.member(userId));
      // The key the retraction re-reads is the one the gate reads.
      expect(
        ops.getKeys().filter((k) => k === kvKeys.kicked(familyId, userId)),
      ).toHaveLength(kickedReads);
      // The session prefixes the negative assertions above filter on are the
      // ones a successful join really writes.
      expect(ops.putKeys()).toContain(kvKeys.auth(userId));
      expect(ops.putKeys()).toContain(kvKeys.authToken(token));
      expect((await getMembers(familyId, token)).status).toBe(200);
    },
  );
});

// ===========================================================================
// (E) A pointer-healing reconnect never writes the family record
// ===========================================================================

describe("POST /api/family/:id/join reconnect displayName update", () => {
  it("should heal the pointer without writing the family record when the pointer is missing", async () => {
    const { familyId } = await createFamilyWithTwoMembers();
    // Listed but pointerless — the shape a removal's revoke leaves behind.
    await kv.delete(kvKeys.member(USER2));
    const nameBefore = await displayNameOf(familyId, USER2);
    expect(nameBefore).not.toBe("Renamed");
    const ops = watchKvOps(kv);

    const res = await join(familyId, USER2, "Renamed");

    expect(res.status).toBe(200);
    expect(ops.putKeys()).toContain(kvKeys.member(USER2));
    expect(ops.putKeys()).not.toContain(kvKeys.family(familyId));
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect(await displayNameOf(familyId, USER2)).toBe(nameBefore);
  });

  it("should still update the displayName on a non-healing reconnect (positive companion)", async () => {
    const { familyId } = await createFamilyWithTwoMembers();
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect(await displayNameOf(familyId, USER2)).not.toBe("Renamed");
    const ops = watchKvOps(kv);

    const res = await join(familyId, USER2, "Renamed");

    expect(res.status).toBe(200);
    expect(ops.putKeys()).toContain(kvKeys.family(familyId));
    expect(ops.putKeys()).not.toContain(kvKeys.member(USER2));
    expect(await displayNameOf(familyId, USER2)).toBe("Renamed");
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
  });
});

// ===========================================================================
// (A) GET bookshelf / members re-check the member list
// ===========================================================================

describe("GET /api/family/:id/{bookshelf,members} with a stale pointer", () => {
  const reads = [
    { label: "bookshelf", call: getBookshelf },
    { label: "members", call: getMembers },
  ];

  it.each(reads)(
    "should answer $label with the same 404 as a pointer mismatch",
    async ({ call }) => {
      const { familyId } = await createFamily(USER1);
      const staleToken = await seedStalePointer(USER3, familyId);
      // Reference answer: a caller whose pointer does not name this family.
      const mismatchToken = await seedAuthToken(kv, USER4);
      const mismatch = await call(familyId, mismatchToken);
      expect(mismatch.status).toBe(404);
      const mismatchBody = await mismatch.text();

      const ops = watchKvOps(kv);
      const res = await call(familyId, staleToken);

      expect(res.status).toBe(404);
      expect(await res.text()).toBe(mismatchBody);
      expect(JSON.parse(mismatchBody).error.code).toBe("NOT_FOUND");
      // Denied before the per-member fan-out: no book record was read.
      expect(
        ops.getKeys().filter((k) => k.startsWith(USER_KEY_PREFIX)),
      ).toEqual([]);
      // Read-only: the stale pointer is left for the remove path to clear.
      expect(ops.writeTrail()).toEqual([]);
    },
  );

  it("should still serve a listed member (positive companion)", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    await seedStalePointer(USER3, familyId);
    const ops = watchKvOps(kv);

    const members = await getMembers(familyId, authToken);
    const shelf = await getBookshelf(familyId, authToken);

    expect(members.status).toBe(200);
    expect(
      ((await members.json()) as Json).data.members.map(
        (m: { userId: string }) => m.userId,
      ),
    ).toEqual([USER1]);
    expect(shelf.status).toBe(200);
    // The prefix the negative assertion above filters on is the one the
    // fan-out really reads.
    expect(ops.getKeys()).toContain(kvKeys.user(USER1));
  });
});

// ===========================================================================
// (B) MEMBER_NOT_FOUND branch clears a stray pointer at this family
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid with a stray pointer", () => {
  it("should clear an unlisted target's pointer and token on the owner's kick, and tombstone them", async () => {
    const { familyId, authToken: ownerToken } = await createFamily(USER1);
    const staleToken = await seedStalePointer(USER3, familyId);
    const ops = watchKvOps(kv);

    const res = await removeMember(familyId, USER3, ownerToken);

    await expectErrorCode(res, 404, "MEMBER_NOT_FOUND");
    expect(await kv.get(kvKeys.member(USER3))).toBeNull();
    expect(await readAuthRecord(USER3)).toBeNull();
    expect(await kv.get(kvKeys.authToken(staleToken))).toBeNull();
    expect(await kv.get(kvKeys.kicked(familyId, USER3))).not.toBeNull();
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    // Tombstone FIRST, then the stray deletes (compared as a set — they run in
    // parallel): a join that observes the deleted pointer must also observe
    // the ban, the same rule the removal branch follows.
    const trail = ops.writeTrail();
    expect(trail[0]).toBe(`put ${kvKeys.kicked(familyId, USER3)}`);
    expect([...trail.slice(1)].sort()).toEqual(
      [
        `delete ${kvKeys.member(USER3)}`,
        `delete ${kvKeys.auth(USER3)}`,
        `delete ${kvKeys.authToken(staleToken)}`,
      ].sort(),
    );
  });

  it("should clear the caller's own stray pointer and token on a self-targeted leave, without a tombstone", async () => {
    const { familyId } = await createFamily(USER1);
    const staleToken = await seedStalePointer(USER3, familyId);
    const ops = watchKvOps(kv);

    const res = await removeMember(familyId, USER3, staleToken);

    await expectErrorCode(res, 404, "MEMBER_NOT_FOUND");
    expect(await kv.get(kvKeys.member(USER3))).toBeNull();
    expect(await readAuthRecord(USER3)).toBeNull();
    expect(await kv.get(kvKeys.authToken(staleToken))).toBeNull();
    // Self-leave is never a kick: no tombstone, so rejoining stays possible.
    expect(await kv.get(kvKeys.kicked(familyId, USER3))).toBeNull();
    expect(ops.putKeys()).not.toContain(kvKeys.kicked(familyId, USER3));
    // Positive companion: the deletes that did run are exactly the stray ones.
    expect([...ops.deleteKeys()].sort()).toEqual(
      [
        kvKeys.member(USER3),
        kvKeys.auth(USER3),
        kvKeys.authToken(staleToken),
      ].sort(),
    );
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
  });

  it.each([
    { label: "the owner's kick", callerIsOwner: true },
    { label: "a self-targeted leave", callerIsOwner: false },
  ])(
    "should leave a pointer naming ANOTHER family alone on $label",
    async ({ callerIsOwner }) => {
      const { familyId, authToken: ownerToken } = await createFamily(USER1);
      const { familyId: otherFamilyId, authToken: otherToken } =
        await createFamily(USER3);
      const ops = watchKvOps(kv);

      const res = await removeMember(
        familyId,
        USER3,
        callerIsOwner ? ownerToken : otherToken,
      );

      await expectErrorCode(res, 404, "MEMBER_NOT_FOUND");
      expect(ops.deleteKeys()).toEqual([]);
      expect(await kv.get(kvKeys.member(USER3))).toBe(otherFamilyId);
      expect((await readAuthRecord(USER3))?.token).toBe(otherToken);
      expect((await getMembers(otherFamilyId, otherToken)).status).toBe(200);
      // Positive companion: the branch ran and read the target's pointer.
      expect(ops.getKeys()).toContain(kvKeys.member(USER3));
    },
  );
});

// ===========================================================================
// (C) create / join ignore a stale pointer
// ===========================================================================
//
// Positive companions (a pointer at a family that DOES list the user ⇒ 409)
// live in tests/unit/familyCreateDuplicate.test.ts (create) and
// tests/integration/familyPartialWrite.test.ts (join).

describe("POST /api/family and /join with a stale pointer", () => {
  it("should create a new family and leave the stale pointer's family untouched", async () => {
    const { familyId: staleFamilyId } = await createFamily(USER1);
    await seedStalePointer(USER3, staleFamilyId);
    const staleRecordBefore = await kv.get(kvKeys.family(staleFamilyId));

    const res = await request("POST", "/api/family", { userId: USER3 });

    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    const familyId = json.data.familyId as string;
    expect(familyId).not.toBe(staleFamilyId);
    expect(await kv.get(kvKeys.member(USER3))).toBe(familyId);
    expect(await listedMemberIds(familyId)).toEqual([USER3]);
    expect(await kv.get(kvKeys.family(staleFamilyId))).toBe(staleRecordBefore);
    expect(
      (await getMembers(familyId, json.data.authToken as string)).status,
    ).toBe(200);
  });

  it("should join a different family instead of answering 409", async () => {
    const { familyId: staleFamilyId } = await createFamily(USER1);
    const { familyId: otherFamilyId } = await createFamily(USER2);
    await seedStalePointer(USER3, staleFamilyId);
    const staleRecordBefore = await kv.get(kvKeys.family(staleFamilyId));

    const res = await join(otherFamilyId, USER3);

    expect(res.status).toBe(200);
    const token = ((await res.json()) as Json).data.authToken as string;
    expect(await kv.get(kvKeys.member(USER3))).toBe(otherFamilyId);
    expect(await listedMemberIds(otherFamilyId)).toEqual([USER2, USER3]);
    expect(await kv.get(kvKeys.family(staleFamilyId))).toBe(staleRecordBefore);
    expect((await getMembers(otherFamilyId, token)).status).toBe(200);
  });
});

// ===========================================================================
// (D) POST /api/auth/lookup
// ===========================================================================

describe("POST /api/auth/lookup membership rule", () => {
  it.each([
    {
      label: "an orphan pointer (family record absent)",
      setup: async () => {
        await kv.put(kvKeys.member(USER3), "dead-beef");
        expect(await kv.get(kvKeys.family("dead-beef"))).toBeNull();
        return { existingFamilyId: null, memberCount: 0 };
      },
    },
    {
      label: "a stale pointer (live family that does not list the user)",
      setup: async () => {
        const { familyId } = await createFamilyWithTwoMembers();
        await seedStalePointer(USER3, familyId);
        return { existingFamilyId: null, memberCount: 0 };
      },
    },
    {
      label: "a listed member (positive companion)",
      setup: async () => {
        const { familyId } = await createFamily(USER1);
        expect((await join(familyId, USER3)).status).toBe(200);
        return { existingFamilyId: familyId, memberCount: 2 };
      },
    },
  ])("should report the real membership for $label", async ({ setup }) => {
    const expected = await setup();

    const res = await lookup(USER3);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data).toEqual({
      ...expected,
      requiresVerification: BoolFlag.FALSE,
    });
  });
});
