/**
 * Multi-key family writes must CONVERGE on retry after a half failure (#213).
 *
 * KV has no transactions. Create, join, member removal and sole-owner dissolve
 * each write two or more keys (`family:{id}`, `member:{uid}`, the auth token
 * pair), so a failure between two writes leaves a half-state. The handlers
 * order those writes so that the ONE half-state each can leave is one its own
 * retry (or the next natural request) repairs:
 *
 * - create: pointer, THEN family  → at worst an orphan `member:{uid}`, which
 *   create cleans up and join ignores.
 * - join (new member): family, THEN pointer → at worst "listed, no pointer",
 *   which the retry's existing-member branch heals.
 * - remove (non-dissolve): [owner kick only: tombstone,] family put, THEN
 *   revoke pointer + token. A failed family put changes nothing but (on a
 *   kick) the tombstone, which the owner's retry finishes or un-kick lifts. A
 *   failed revoke leaves "unlisted, stray pointer (+ token)", which reads
 *   nothing family-scoped, and which any retry — the owner's re-kick or the
 *   target's own retried leave — clears on the MEMBER_NOT_FOUND branch.
 * - dissolve: family delete, THEN pointer + token → at worst an orphan pointer.
 *
 * Every case here drives the real Hono app over `app.request` with a
 * `createMockKV()` store (TTL floor intact) and makes exactly ONE KV operation
 * on ONE key throw ONCE (a write, or — to stop a revoke before it starts — the
 * read in front of it). The assertions are on the FINAL KV state after the retry,
 * plus `writeTrail()` pins on the success paths so a reordering fails loudly
 * even when the retry happens to still converge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import { kvKeys, type AuthRecord } from "../../src/kv/schema";
import { USER1, USER2, USER3 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The store every assertion reads, and the one `watchKvOps` observes. */
let kv: KVNamespace;
/**
 * What the app is handed as `env.KV`. Normally `kv` itself; a fault injector
 * swaps in a Proxy over `kv` that fails one write, so only writes that really
 * LANDED reach `kv` (and therefore a trail watching it).
 */
let envKv: KVNamespace;

/**
 * `"family:"`, taken from the production key builder so the "no other family
 * record exists" assertions cannot pass vacuously after a key rename.
 */
const FAMILY_KEY_PREFIX = kvKeys.family("");

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

function createRequest(userId: string) {
  return request("POST", "/api/family", { userId });
}

async function createFamily(userId: string) {
  const res = await createRequest(userId);
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

function join(familyId: string, userId: string) {
  return request("POST", `/api/family/${familyId}/join`, { userId });
}

async function joinOk(familyId: string, userId: string): Promise<string> {
  const res = await join(familyId, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

/** USER1 owns the family, USER2 is an ordinary member. */
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

function getMembers(familyId: string, token: string) {
  return request("GET", `/api/family/${familyId}/members`, undefined, token);
}

function getBookshelf(familyId: string, token: string) {
  return request("GET", `/api/family/${familyId}/bookshelf`, undefined, token);
}

/** Member userIds as the family record stores them (read straight from KV). */
async function listedMemberIds(familyId: string): Promise<string[]> {
  const record = await kv.get<{ members: { userId: string }[] }>(
    kvKeys.family(familyId),
    "json",
  );
  expect(record).not.toBeNull();
  return record!.members.map((m) => m.userId);
}

/** Every `family:*` key in the store, whichever family it belongs to. */
async function allFamilyRecordKeys(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys
    .map((k) => k.name)
    .filter((name) => name.startsWith(FAMILY_KEY_PREFIX));
}

function readAuthRecord(userId: string) {
  return kv.get<AuthRecord>(kvKeys.auth(userId), "json");
}

async function expectInternalError(res: Response) {
  expect(res.status).toBe(500);
  expect(((await res.json()) as Json).error.code).toBe("INTERNAL_ERROR");
}

/**
 * Let KV operations orphaned by a rejected `Promise.all` finish. A fault on
 * one member of a parallel group rejects the group at once, while its siblings
 * keep running after the 500 is returned. `createMockKV()` resolves on
 * microtasks only, so one macrotask turn drains them.
 */
function settleOrphanedKvOps(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Sort a slice of a write trail so a parallel group compares as a SET. */
function asSet(entries: string[]): string[] {
  return [...entries].sort();
}

interface InjectedFault {
  /** True once the injected throw has actually happened. */
  fired: () => boolean;
  /** The key the throw fired on (`null` until it fires). */
  failedKey: () => string | null;
}

/**
 * Make the NEXT `op` on a matching key throw, once; every other call — and
 * every later call on that key — goes straight through to `kv`. `match` is an
 * exact key, or a predicate when the key is minted inside the handler (create's
 * random familyId).
 *
 * A Proxy rather than `vi.spyOn(kv, op)`: `watchKvOps(kv)` spies on the same
 * methods, and stacking a second spy on one property is fragile. Delegation
 * resolves `kv[op]` at CALL time, so a trail installed on `kv` after this still
 * records every write that landed. A failed write never reaches `kv`, so it is
 * absent from the trail by construction.
 *
 * The throw escapes the handler into `app.onError`, which logs it; that log is
 * silenced here (and restored by `vi.restoreAllMocks()` in `afterEach`).
 *
 * Callers MUST assert `fired()` — otherwise a handler that stopped writing the
 * key at all would pass every "after the failure" assertion vacuously.
 *
 * `"get"` is supported for the one case a write fault cannot reach: a revoke
 * that never starts (its pointer read fails), so neither the pointer nor the
 * token delete runs.
 */
function failNextKvOp(
  op: "get" | "put" | "delete",
  match: string | ((key: string) => boolean),
): InjectedFault {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const matches =
    typeof match === "string" ? (key: string) => key === match : match;
  let failedKey: string | null = null;
  envKv = new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === op) {
        return async (key: string, ...rest: unknown[]): Promise<unknown> => {
          if (failedKey === null && matches(key)) {
            failedKey = key;
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
  return { fired: () => failedKey !== null, failedKey: () => failedKey };
}

beforeEach(() => {
  kv = createMockKV();
  envKv = kv;
});

afterEach(() => {
  // watchKvOps and the console.error silencer install spies that do not clean
  // up after themselves.
  vi.restoreAllMocks();
});

// ===========================================================================
// POST /api/family
// ===========================================================================

describe("POST /api/family partial-write convergence", () => {
  it("should write the member pointer before the family record", async () => {
    const ops = watchKvOps(kv);

    const res = await createRequest(USER1);

    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    const familyId = json.data.familyId as string;
    const token = json.data.authToken as string;
    const trail = ops.writeTrail();
    // Pointer strictly FIRST: the reverse order can strand a `family:{id}` that
    // nobody points at, which the retry (fresh familyId) never reaches again.
    expect(trail.slice(0, 2)).toEqual([
      `put ${kvKeys.member(USER1)}`,
      `put ${kvKeys.family(familyId)}`,
    ]);
    // Token pair is written in parallel, after both membership keys.
    expect(asSet(trail.slice(2))).toEqual(
      asSet([`put ${kvKeys.auth(USER1)}`, `put ${kvKeys.authToken(token)}`]),
    );
  });

  it("should leave only an orphan pointer when the family put fails, and converge on retry", async () => {
    const ops = watchKvOps(kv);
    // The familyId is minted inside the handler, so match on the prefix.
    const fault = failNextKvOp("put", (key) =>
      key.startsWith(FAMILY_KEY_PREFIX),
    );

    const first = await createRequest(USER1);

    await expectInternalError(first);
    expect(fault.fired()).toBe(true);
    const orphanFamilyId = fault.failedKey()!.slice(FAMILY_KEY_PREFIX.length);
    // The one half-state create may leave: a pointer at a family that does
    // not exist. No family record, no token.
    expect(await kv.get(kvKeys.member(USER1))).toBe(orphanFamilyId);
    expect(await allFamilyRecordKeys()).toEqual([]);
    expect(await readAuthRecord(USER1)).toBeNull();
    expect(ops.writeTrail()).toEqual([`put ${kvKeys.member(USER1)}`]);

    const retry = await createRequest(USER1);

    expect(retry.status).toBe(201);
    const json = (await retry.json()) as Json;
    const familyId = json.data.familyId as string;
    expect(familyId).not.toBe(orphanFamilyId);
    expect(await kv.get(kvKeys.member(USER1))).toBe(familyId);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    // No permanent orphan: the ONLY family record is the new one.
    expect(await allFamilyRecordKeys()).toEqual([kvKeys.family(familyId)]);
    // ...and the new session can actually read it.
    expect(
      (await getMembers(familyId, json.data.authToken as string)).status,
    ).toBe(200);
  });

  it("should let the orphan-pointer user join a DIFFERENT existing family instead of answering 409", async () => {
    const { familyId: otherFamilyId } = await createFamily(USER2);
    // A pointer at a family that does not exist — exactly what the failed
    // create above leaves behind.
    const orphanFamilyId = "dead-beef";
    await kv.put(kvKeys.member(USER1), orphanFamilyId);
    expect(await kv.get(kvKeys.family(orphanFamilyId))).toBeNull();

    const res = await join(otherFamilyId, USER1);

    expect(res.status).toBe(200);
    const token = ((await res.json()) as Json).data.authToken as string;
    expect(await kv.get(kvKeys.member(USER1))).toBe(otherFamilyId);
    expect(await listedMemberIds(otherFamilyId)).toEqual([USER2, USER1]);
    expect((await getMembers(otherFamilyId, token)).status).toBe(200);
  });

  it("should still answer 409 ALREADY_IN_FAMILY when the pointer names a LIVE different family", async () => {
    // Positive companion to the orphan case: a pointer counts as membership
    // when the family record EXISTS and LISTS the user. An absent record (the
    // orphan above) or one that no longer lists the user (a stale pointer —
    // tests/integration/familyStaleMembership.test.ts) downgrades it to "no
    // membership".
    const { familyId: ownFamilyId } = await createFamily(USER1);
    const { familyId: otherFamilyId } = await createFamily(USER2);
    const ops = watchKvOps(kv);

    const res = await join(otherFamilyId, USER1);

    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe("ALREADY_IN_FAMILY");
    expect(ops.writeTrail()).toEqual([]);
    expect(await kv.get(kvKeys.member(USER1))).toBe(ownFamilyId);
    expect(await listedMemberIds(otherFamilyId)).toEqual([USER2]);
  });
});

// ===========================================================================
// POST /api/family/:id/join
// ===========================================================================

describe("POST /api/family/:id/join partial-write convergence", () => {
  it("should write the family record before the new member's pointer", async () => {
    const { familyId } = await createFamily(USER1);
    const ops = watchKvOps(kv);

    const res = await join(familyId, USER2);

    expect(res.status).toBe(200);
    const token = ((await res.json()) as Json).data.authToken as string;
    const trail = ops.writeTrail();
    // Record strictly FIRST: a pointer at a family that does not list the user
    // can get stuck (FAMILY_FULL here, ALREADY_IN_FAMILY everywhere else).
    expect(trail.slice(0, 2)).toEqual([
      `put ${kvKeys.family(familyId)}`,
      `put ${kvKeys.member(USER2)}`,
    ]);
    expect(asSet(trail.slice(2))).toEqual(
      asSet([`put ${kvKeys.auth(USER2)}`, `put ${kvKeys.authToken(token)}`]),
    );
  });

  it("should heal the missing pointer when the same join is retried after the pointer put failed", async () => {
    const { familyId, authToken: ownerToken } = await createFamily(USER1);
    const fault = failNextKvOp("put", kvKeys.member(USER2));

    const first = await join(familyId, USER2);

    await expectInternalError(first);
    expect(fault.fired()).toBe(true);
    // Half-state: listed, but no pointer and no token.
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await readAuthRecord(USER2)).toBeNull();

    const ops = watchKvOps(kv);
    const retry = await join(familyId, USER2);

    expect(retry.status).toBe(200);
    const token = ((await retry.json()) as Json).data.authToken as string;
    // The retry takes the existing-member branch, and its FIRST write is the heal.
    expect(ops.writeTrail()[0]).toBe(`put ${kvKeys.member(USER2)}`);
    expect(ops.writeTrail()).not.toContain(`put ${kvKeys.family(familyId)}`);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    // Listed exactly once — the retry did not append a second entry.
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);

    // The pointer is the membership authority: both reads now admit USER2.
    const members = await getMembers(familyId, token);
    expect(members.status).toBe(200);
    const memberIds = ((await members.json()) as Json).data.members.map(
      (m: { userId: string }) => m.userId,
    );
    expect(memberIds).toEqual([USER1, USER2]);
    expect((await getBookshelf(familyId, token)).status).toBe(200);
    // The owner is untouched by all of it.
    expect((await getMembers(familyId, ownerToken)).status).toBe(200);
  });

  it.each([
    { label: "absent", pointer: null },
    { label: "an orphan (absent family)", pointer: "dead-beef" },
  ])(
    "should heal a listed member's pointer that is $label on reconnect",
    async ({ pointer }) => {
      const { familyId } = await createFamilyWithTwoMembers();
      if (pointer === null) {
        await kv.delete(kvKeys.member(USER2));
      } else {
        await kv.put(kvKeys.member(USER2), pointer);
      }
      const ops = watchKvOps(kv);

      const res = await join(familyId, USER2);

      expect(res.status).toBe(200);
      const token = ((await res.json()) as Json).data.authToken as string;
      expect(ops.writeTrail()[0]).toBe(`put ${kvKeys.member(USER2)}`);
      expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
      expect((await getMembers(familyId, token)).status).toBe(200);
    },
  );

  it("should not rewrite a pointer that already names this family on reconnect", async () => {
    const { familyId } = await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    const res = await join(familyId, USER2);

    expect(res.status).toBe(200);
    // Positive companion: the watch is live (the token TTL refresh lands)...
    expect(ops.putKeys()).toContain(kvKeys.auth(USER2));
    // ...and the heal is skipped when there is nothing to heal.
    expect(ops.putKeys()).not.toContain(kvKeys.member(USER2));
  });
});

// ===========================================================================
// DELETE /api/family/:id/member/:uid (not the sole-owner dissolve)
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid partial-write convergence", () => {
  it("should tombstone an owner kick first, then update the member list, then revoke pointer and token", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    const res = await removeMember(familyId, USER2, ownerToken);

    expect(res.status).toBe(200);
    const trail = ops.writeTrail();
    // Tombstone strictly FIRST: a join that observes the revoked pointer must
    // also observe the tombstone, or it heals the pointer back (#213, Fix
    // Cycle 3 — see familyStaleMembership.test.ts for the race itself). The
    // list put comes next: once it lands the removal has taken effect, and a
    // revoke that fails after it leaves only a stray pointer that reads nothing.
    expect(trail.slice(0, 2)).toEqual([
      `put ${kvKeys.kicked(familyId, USER2)}`,
      `put ${kvKeys.family(familyId)}`,
    ]);
    // The three revoke deletes run in parallel — compared as a set — and are
    // the last writes.
    expect(asSet(trail.slice(2))).toEqual(
      asSet([
        `delete ${kvKeys.member(USER2)}`,
        `delete ${kvKeys.auth(USER2)}`,
        `delete ${kvKeys.authToken(memberToken)}`,
      ]),
    );
  });

  it("should update the member list before revoking pointer and token on a self-leave, with no tombstone", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    const res = await removeMember(familyId, USER2, memberToken);

    expect(res.status).toBe(200);
    const trail = ops.writeTrail();
    // List first: a revoke that fails after it leaves the leaver's own token
    // alive, so they can retry the leave (see the self-leave cases below).
    expect(trail[0]).toBe(`put ${kvKeys.family(familyId)}`);
    expect(asSet(trail.slice(1))).toEqual(
      asSet([
        `delete ${kvKeys.member(USER2)}`,
        `delete ${kvKeys.auth(USER2)}`,
        `delete ${kvKeys.authToken(memberToken)}`,
      ]),
    );
  });

  it("should revoke nothing when the kick's family put fails, refuse the still-listed target's reconnect, and converge on the owner's retry", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    const fault = failNextKvOp("put", kvKeys.family(familyId));

    const first = await removeMember(familyId, USER2, ownerToken);

    await expectInternalError(first);
    expect(fault.fired()).toBe(true);
    // The revoke never started: still listed, pointer and session intact —
    // the kick simply did not happen, and the owner (answered 500) still sees
    // them and can retry.
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect((await readAuthRecord(USER2))?.token).toBe(memberToken);
    expect(await kv.get(kvKeys.authToken(memberToken))).toBe(USER2);
    // The accepted trade-off of tombstone-first: the kick failed, yet its
    // tombstone stands, so the still-listed target's reconnect is refused
    // (fail-closed) for up to the tombstone TTL.
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).not.toBeNull();
    envKv = kv;
    const reconnect = await join(familyId, USER2);
    expect(reconnect.status).toBe(403);
    expect(((await reconnect.json()) as Json).error.code).toBe(
      "MEMBER_REMOVED",
    );
    // Refused with no second list entry and no new session minted.
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    expect((await readAuthRecord(USER2))?.token).toBe(memberToken);

    const ops = watchKvOps(kv);
    const retry = await removeMember(familyId, USER2, ownerToken);

    expect(retry.status).toBe(200);
    // The retry is a complete removal in the pinned order.
    const trail = ops.writeTrail();
    expect(trail.slice(0, 2)).toEqual([
      `put ${kvKeys.kicked(familyId, USER2)}`,
      `put ${kvKeys.family(familyId)}`,
    ]);
    expect(asSet(trail.slice(2))).toEqual(
      asSet([
        `delete ${kvKeys.member(USER2)}`,
        `delete ${kvKeys.auth(USER2)}`,
        `delete ${kvKeys.authToken(memberToken)}`,
      ]),
    );
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await readAuthRecord(USER2)).toBeNull();
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).not.toBeNull();
    expect((await getMembers(familyId, memberToken)).status).toBe(401);
    expect((await getMembers(familyId, ownerToken)).status).toBe(200);
  });

  it("should unlist the target even when the pointer delete fails, leave a stray pointer that reads nothing, and clear it on the owner's retry", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    const fault = failNextKvOp("delete", kvKeys.member(USER2));

    const first = await removeMember(familyId, USER2, ownerToken);

    await expectInternalError(first);
    expect(fault.fired()).toBe(true);
    // The list put landed BEFORE the failed revoke: the removal took effect
    // (Inv-4) and only a stray pointer is left behind.
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).not.toBeNull();

    // Worst case beside that pointer: a live session. The token delete may not
    // have run, and `POST /api/auth/refresh` checks the pointer only, so it
    // can renew one — seed it directly rather than depend on either. The
    // parallel token delete outlives the rejected `Promise.all`, so let it
    // settle first (the mock KV is microtask-only) or it could land on the seed.
    await settleOrphanedKvOps();
    const strayToken = await seedAuthToken(kv, USER2);
    envKv = kv;
    // It reads nothing family-scoped: the same 404 as any non-member.
    for (const read of [getBookshelf, getMembers]) {
      const res = await read(familyId, strayToken);
      expect(res.status).toBe(404);
      expect(((await res.json()) as Json).error.code).toBe("NOT_FOUND");
    }
    // ...and the ban still refuses the unlisted target's rejoin.
    const reconnect = await join(familyId, USER2);
    expect(reconnect.status).toBe(403);
    expect(((await reconnect.json()) as Json).error.code).toBe(
      "MEMBER_REMOVED",
    );
    expect(await listedMemberIds(familyId)).toEqual([USER1]);

    const ops = watchKvOps(kv);
    const retry = await removeMember(familyId, USER2, ownerToken);

    // The owner's re-kick lands on MEMBER_NOT_FOUND, which re-asserts the ban
    // and clears the stray pointer together with its token.
    expect(retry.status).toBe(404);
    expect(((await retry.json()) as Json).error.code).toBe("MEMBER_NOT_FOUND");
    const trail = ops.writeTrail();
    expect(trail[0]).toBe(`put ${kvKeys.kicked(familyId, USER2)}`);
    expect(asSet(trail.slice(1))).toEqual(
      asSet([
        `delete ${kvKeys.member(USER2)}`,
        `delete ${kvKeys.auth(USER2)}`,
        `delete ${kvKeys.authToken(strayToken)}`,
      ]),
    );
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await readAuthRecord(USER2)).toBeNull();
    expect(await kv.get(kvKeys.authToken(strayToken))).toBeNull();
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).not.toBeNull();
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
  });

  it.each([
    {
      label: "the family put (still listed)",
      fault: (familyId: string) => failNextKvOp("put", kvKeys.family(familyId)),
      listedAfterFailure: [USER1, USER2],
    },
    {
      label: "the pointer delete (unlisted, stray pointer)",
      fault: () => failNextKvOp("delete", kvKeys.member(USER2)),
      listedAfterFailure: [USER1],
    },
  ])(
    "should let the owner's un-kick restore a target whose kick failed at $label",
    async ({ fault: inject, listedAfterFailure }) => {
      const { familyId, ownerToken } = await createFamilyWithTwoMembers();
      const fault = inject(familyId);
      await expectInternalError(
        await removeMember(familyId, USER2, ownerToken),
      );
      expect(fault.fired()).toBe(true);
      await settleOrphanedKvOps();
      envKv = kv;
      // Precondition: the failed kick left its half-state, and the ban.
      expect(await listedMemberIds(familyId)).toEqual(listedAfterFailure);
      expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
      expect((await join(familyId, USER2)).status).toBe(403);

      // The other documented way out of the trade-off: the owner changes their
      // mind instead of retrying, and lifts the ban. Still listed ⇒ the
      // reconnect takes the existing-member branch; unlisted ⇒ the stray
      // pointer does not count as membership, so it rejoins as a new member.
      const unkick = await request(
        "DELETE",
        `/api/family/${familyId}/kicked/${USER2}`,
        undefined,
        ownerToken,
      );
      expect(unkick.status).toBe(200);
      expect(await kv.get(kvKeys.kicked(familyId, USER2))).toBeNull();

      // Either way: listed exactly once, with a working session.
      const token = await joinOk(familyId, USER2);
      expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
      expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
      expect((await getMembers(familyId, token)).status).toBe(200);
      expect((await getBookshelf(familyId, token)).status).toBe(200);
    },
  );

  it("should revoke nothing when a self-leave's family put fails, so the same session can retry the leave at once", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    const fault = failNextKvOp("put", kvKeys.family(familyId));

    await expectInternalError(await removeMember(familyId, USER2, memberToken));
    expect(fault.fired()).toBe(true);
    envKv = kv;
    // Nothing happened: still listed, pointer and session intact, no ban.
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).toBeNull();
    expect((await getMembers(familyId, memberToken)).status).toBe(200);

    // The leaver's own token still works, so their retry completes the leave.
    const retry = await removeMember(familyId, USER2, memberToken);

    expect(retry.status).toBe(200);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await readAuthRecord(USER2)).toBeNull();
    expect(await kv.get(kvKeys.authToken(memberToken))).toBeNull();
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).toBeNull();
  });

  it("should let a member whose self-leave failed before its revoke retry the leave, clearing the stray pointer and token without a tombstone", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    // The revoke's pointer read fails AFTER the list put landed, so neither
    // the pointer nor the token delete runs.
    const fault = failNextKvOp("get", kvKeys.member(USER2));

    await expectInternalError(await removeMember(familyId, USER2, memberToken));
    expect(fault.fired()).toBe(true);
    envKv = kv;
    // Unlisted — the leave took effect — with a stray pointer and a live token.
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect(await kv.get(kvKeys.authToken(memberToken))).toBe(USER2);
    // That leftover reads nothing family-scoped: the same 404 as a non-member.
    for (const read of [getBookshelf, getMembers]) {
      const res = await read(familyId, memberToken);
      expect(res.status).toBe(404);
      expect(((await res.json()) as Json).error.code).toBe("NOT_FOUND");
    }

    const ops = watchKvOps(kv);
    const retry = await removeMember(familyId, USER2, memberToken);

    // The retried leave lands on MEMBER_NOT_FOUND, which clears the stray
    // pointer and the caller's own token — and, a self-leave, bans nothing.
    expect(retry.status).toBe(404);
    expect(((await retry.json()) as Json).error.code).toBe("MEMBER_NOT_FOUND");
    expect(asSet(ops.writeTrail())).toEqual(
      asSet([
        `delete ${kvKeys.member(USER2)}`,
        `delete ${kvKeys.auth(USER2)}`,
        `delete ${kvKeys.authToken(memberToken)}`,
      ]),
    );
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await readAuthRecord(USER2)).toBeNull();
    expect(await kv.get(kvKeys.authToken(memberToken))).toBeNull();
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).toBeNull();
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
  });

  it("should not count a self-leave's stray pointer as membership when only its pointer delete failed", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    const fault = failNextKvOp("delete", kvKeys.member(USER2));

    await expectInternalError(await removeMember(familyId, USER2, memberToken));
    expect(fault.fired()).toBe(true);
    await settleOrphanedKvOps();
    envKv = kv;
    // Unlisted with a stray pointer; the parallel token delete did land, so
    // the leaver cannot retry the DELETE themselves...
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect((await removeMember(familyId, USER2, memberToken)).status).toBe(401);

    // ...but the stray pointer blocks nothing: rejoining works (a new-member
    // join — no ALREADY_IN_FAMILY, no tombstone from a self-leave), listed
    // exactly once, with a session that reads the family.
    const newToken = await joinOk(familyId, USER2);
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect((await getMembers(familyId, newToken)).status).toBe(200);
    expect(await kv.get(kvKeys.kicked(familyId, USER2))).toBeNull();
  });

  it("should not delete the target's pointer or token when the pointer names ANOTHER family", async () => {
    const { familyId, authToken: ownerToken } = await createFamily(USER1);
    // Reach "listed here, pointer elsewhere" the way production can: a join
    // whose pointer put failed after its record put (listed, no pointer, no
    // session), then the target joins another family instead of retrying.
    const fault = failNextKvOp("put", kvKeys.member(USER2));
    await expectInternalError(await join(familyId, USER2));
    expect(fault.fired()).toBe(true);
    envKv = kv;
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    const { familyId: otherFamilyId } = await createFamily(USER3);
    const otherToken = await joinOk(otherFamilyId, USER2);
    expect(await kv.get(kvKeys.member(USER2))).toBe(otherFamilyId);
    expect(await listedMemberIds(familyId)).toEqual([USER1, USER2]);

    const ops = watchKvOps(kv);
    const res = await removeMember(familyId, USER2, ownerToken);

    expect(res.status).toBe(200);
    expect(await listedMemberIds(familyId)).toEqual([USER1]);
    // The session in the OTHER family is left alone: no member / auth / token
    // delete at all, and it still reads that family.
    expect(ops.deleteKeys()).toEqual([]);
    expect(await kv.get(kvKeys.member(USER2))).toBe(otherFamilyId);
    expect((await readAuthRecord(USER2))?.token).toBe(otherToken);
    expect((await getMembers(otherFamilyId, otherToken)).status).toBe(200);
    // Positive companion: the tombstone and the list update did land, in
    // tombstone-first order, and the revoke did read the target's pointer.
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.kicked(familyId, USER2)}`,
      `put ${kvKeys.family(familyId)}`,
    ]);
    expect(ops.getKeys()).toContain(kvKeys.member(USER2));
  });
});

// ===========================================================================
// DELETE /api/family/:id/member/:uid — sole-owner dissolve
// ===========================================================================

describe("Sole-owner dissolve partial-write convergence", () => {
  it("should delete the family record before the owner's pointer and token", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    const ops = watchKvOps(kv);

    const res = await removeMember(familyId, USER1, authToken);

    expect(res.status).toBe(200);
    const trail = ops.writeTrail();
    expect(trail[0]).toBe(`delete ${kvKeys.family(familyId)}`);
    expect(asSet(trail.slice(1))).toEqual(
      asSet([
        `delete ${kvKeys.member(USER1)}`,
        `delete ${kvKeys.auth(USER1)}`,
        `delete ${kvKeys.authToken(authToken)}`,
      ]),
    );
  });

  it("should keep the owner's pointer and token when the family delete fails, so the same session can retry", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    const fault = failNextKvOp("delete", kvKeys.family(familyId));

    const first = await removeMember(familyId, USER1, authToken);

    await expectInternalError(first);
    expect(fault.fired()).toBe(true);
    // Nothing after the family delete ran: had the pointer / token deletes run
    // alongside it, the family would outlive every key that reaches it.
    expect(await kv.get(kvKeys.member(USER1))).toBe(familyId);
    expect((await readAuthRecord(USER1))?.token).toBe(authToken);

    const retry = await removeMember(familyId, USER1, authToken);

    expect(retry.status).toBe(200);
    expect(await allFamilyRecordKeys()).toEqual([]);
    expect(await kv.get(kvKeys.member(USER1))).toBeNull();
    expect(await readAuthRecord(USER1)).toBeNull();
  });

  const failingKeys = [
    { label: "pointer", key: kvKeys.member(USER1) },
    { label: "auth record", key: kvKeys.auth(USER1) },
  ];
  const followUps = [
    {
      label: "create a new family",
      run: async () => {
        const res = await createRequest(USER1);
        expect(res.status).toBe(201);
        return ((await res.json()) as Json).data.familyId as string;
      },
    },
    {
      label: "join another family",
      run: async () => {
        // Built through the real app with the fault already spent.
        const { familyId } = await createFamily(USER2);
        expect((await join(familyId, USER1)).status).toBe(200);
        return familyId;
      },
    },
  ];
  const cases = failingKeys.flatMap((failing) =>
    followUps.map((followUp) => ({
      name: `${failing.label} delete fails, then the owner can ${followUp.label}`,
      failingKey: failing.key,
      followUp: followUp.run,
    })),
  );

  it.each(cases)("should not leave the owner stuck: $name", async (tc) => {
    const { familyId } = await createFamily(USER1);
    const token = (await readAuthRecord(USER1))!.token;
    const fault = failNextKvOp("delete", tc.failingKey);

    const first = await removeMember(familyId, USER1, token);

    await expectInternalError(first);
    expect(fault.fired()).toBe(true);
    // The family is gone regardless — whatever is left is an orphan pointer
    // or a token that no longer reaches any family.
    expect(await kv.get(kvKeys.family(familyId))).toBeNull();
    expect(await allFamilyRecordKeys()).toEqual([]);

    const nextFamilyId = await tc.followUp();

    // No stuck ALREADY_IN_FAMILY: the owner is now in the new family.
    expect(await kv.get(kvKeys.member(USER1))).toBe(nextFamilyId);
    expect(await listedMemberIds(nextFamilyId)).toContain(USER1);
    const newToken = (await readAuthRecord(USER1))!.token;
    expect((await getMembers(nextFamilyId, newToken)).status).toBe(200);
  });
});
