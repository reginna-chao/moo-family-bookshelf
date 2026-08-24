/**
 * Owner-initiated removal must STICK — the `kicked:{familyId}:{userId}` tombstone.
 *
 * Without it, `DELETE /api/family/:id/member/:uid` removed a member who was
 * back seconds later: the removed client retries `POST /:id/join` with just
 * `{ userId }` and, since no secret is needed for an account with no
 * verification configured, walks straight back into the family. The tombstone
 * closes that loop for `KICKED_TOMBSTONE_TTL_SECONDS`.
 *
 * Covered end-to-end over the real HTTP path (`app.request` against the Hono
 * app + a mock KV), because the behaviour is a contract BETWEEN two handlers:
 * the DELETE writes the key, the join refuses on it. Cases split four ways —
 * what the removal writes, what the join then refuses, the paths that must
 * write NOTHING (voluntary leave, sole-owner dissolve, and every REFUSED
 * removal), since a tombstone on any of those would lock a user out of a
 * legitimate leave-then-rejoin, and the idempotent re-kick on the
 * MEMBER_NOT_FOUND path, which is what keeps a ban appliable after a removal
 * that half-failed.
 *
 * TTLs are asserted via `getPutTtl`, never simulated: `createMockKV` keeps an
 * accepted put readable forever, so "the tombstone expired" is modelled by
 * deleting the key (see the mock's own doc comment).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import {
  kvKeys,
  KICKED_TOMBSTONE_TTL_SECONDS,
  type KickedRecord,
} from "../../src/kv/schema";
import { USER1, USER2, USER3 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

/**
 * The production 繁中 copy of the tombstone refusal (`routes/family.ts`).
 * Every assertion on it runs through `app.request`, so it hits the real throw
 * site — a copy change fails here instead of passing against a test-local
 * duplicate (test.md, "User-visible copy needs a production-anchored assertion").
 */
const MEMBER_REMOVED_MESSAGE = "你已被管理者移出此家庭，暫時無法重新加入";

/**
 * The production 繁中 copy of the "target is not a member" refusal
 * (`routes/family.ts`). Pinned here because the re-kick branch must leave that
 * response completely untouched — the tombstone it writes on the way out is a
 * side effect the caller must not be able to detect.
 */
const MEMBER_NOT_FOUND_MESSAGE = "目標使用者不是家庭成員";

/**
 * `"kicked:"`, taken FROM the production key builder instead of typed out, so
 * the "no tombstone anywhere" assertions cannot keep passing after a key
 * rename. The placeholders are only markers to slice on.
 */
const KICKED_KEY_PREFIX = kvKeys.kicked("{familyId}", "{userId}").split("{")[0];

// ---------------------------------------------------------------------------
// Helpers (same shape as familyLifecycle.test.ts: real app, mock KV, DEV_MODE
// so the rate limiters never interfere with the behaviour under test)
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
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamily(userId = USER1) {
  const res = await request("POST", "/api/family", { userId });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

/** USER1 owns the family, USER2 is the ordinary member the owner can remove. */
async function createFamilyWithTwoMembers() {
  const { familyId, authToken: ownerToken } = await createFamily(USER1);
  const joinRes = await join(familyId, USER2);
  expect(joinRes.status).toBe(200);
  const memberToken = ((await joinRes.json()) as Json).data.authToken as string;
  return { familyId, ownerToken, memberToken };
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

function readTombstone(familyId: string, userId: string) {
  return kv.get<KickedRecord>(kvKeys.kicked(familyId, userId), "json");
}

/** Every tombstone key currently in the keyspace, whichever family it belongs to. */
async function allTombstoneKeys(): Promise<string[]> {
  const { keys } = await kv.list();
  return keys
    .map((k) => k.name)
    .filter((name) => name.startsWith(KICKED_KEY_PREFIX));
}

/**
 * Swap `kv` for a wrapper that throws on `put` for ONE key and calls straight
 * through for everything else, so only the tombstone write fails — the same
 * trick `verificationGate.test.ts` uses to observe KV without replacing it.
 *
 * Returns a `restore()` that puts the plain mock back. The retry case needs it
 * (its SECOND attempt must be allowed to write), and `getPutTtl` needs it too:
 * the TTL registry is keyed on the instance `createMockKV()` returned, never on
 * this wrapper. Tests that only ever fail can ignore the return — `beforeEach`
 * builds a fresh mock, so there is nothing to clean up.
 */
function failPutFor(failingKey: string): () => void {
  const base = kv;
  const put = base.put.bind(base) as (
    key: string,
    value: string,
    opts?: unknown,
  ) => Promise<void>;
  kv = {
    ...base,
    put: async (key: string, value: string, opts?: unknown): Promise<void> => {
      if (key === failingKey) {
        throw new Error(`simulated KV put failure for "${key}"`);
      }
      return put(key, value, opts);
    },
  } as unknown as KVNamespace;
  return () => {
    kv = base;
  };
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

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  // watchKvOps installs vi.spyOn handlers and the fail-open case spies on
  // console.error; neither cleans up after itself.
  vi.restoreAllMocks();
});

// ===========================================================================
// DELETE /api/family/:id/member/:uid — what the removal writes
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid tombstone write", () => {
  it("should record who removed the member, and when, under the kicked key", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();

    const res = await removeMember(familyId, USER2, ownerToken);
    expect(res.status).toBe(200);

    const tombstone = await readTombstone(familyId, USER2);
    expect(tombstone).not.toBeNull();
    expect(tombstone!.removedBy).toBe(USER1);
    // Diagnostic only (the gate reads presence, never the value), but it must
    // still be a real timestamp rather than an empty placeholder.
    expect(Number.isNaN(Date.parse(tombstone!.removedAt))).toBe(false);

    // Scoped to (family, user): removing USER2 tombstones nothing else.
    expect(await allTombstoneKeys()).toEqual([kvKeys.kicked(familyId, USER2)]);
  });

  it("should write the tombstone with the production TTL", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();

    await removeMember(familyId, USER2, ownerToken);

    // Bounded lifetime is the whole design: after it, a sync-code rejoin is
    // legitimate again (Inv-4 requires immediate removal, not a permanent ban).
    expect(getPutTtl(kv, kvKeys.kicked(familyId, USER2))).toBe(
      KICKED_TOMBSTONE_TTL_SECONDS,
    );
  });

  it("should write the tombstone only after the removal writes have landed", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    await removeMember(familyId, USER2, ownerToken);

    // Ordering is a safety property, not a style choice: a tombstone that
    // outran a FAILED removal would lock a still-live member out of
    // reconnecting for the whole TTL. It must therefore be the LAST write.
    const trail = ops.writeTrail();
    const kickedAt = trail.indexOf(`put ${kvKeys.kicked(familyId, USER2)}`);
    const familyAt = trail.indexOf(`put ${kvKeys.family(familyId)}`);
    const memberAt = trail.indexOf(`delete ${kvKeys.member(USER2)}`);
    expect(familyAt).toBeGreaterThanOrEqual(0);
    expect(memberAt).toBeGreaterThanOrEqual(0);
    expect(kickedAt).toBe(trail.length - 1);
    expect(kickedAt).toBeGreaterThan(Math.max(familyAt, memberAt));
  });

  it("should write NO tombstone when a member leaves voluntarily", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();

    // Self-leave: caller === target, so the owner never expressed any intent.
    const res = await removeMember(familyId, USER2, memberToken);
    expect(res.status).toBe(200);

    expect(await allTombstoneKeys()).toEqual([]);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1]);
  });

  it("should let a member who left voluntarily rejoin immediately", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    await removeMember(familyId, USER2, memberToken);

    // The flow settingsPersistence.test.ts depends on: leave, then come back.
    const rejoinRes = await join(familyId, USER2);

    expect(rejoinRes.status).toBe(200);
    const json = (await rejoinRes.json()) as Json;
    expect(json.data.authToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER2]);
  });

  it("should write NO tombstone when the sole-member owner dissolves the family", async () => {
    const { familyId, authToken } = await createFamily(USER1);

    const res = await removeMember(familyId, USER1, authToken);
    expect(res.status).toBe(200);

    // That branch early-returns before the tombstone block; a tombstone here
    // would ban the owner from re-creating/rejoining their own family id.
    expect(await allTombstoneKeys()).toEqual([]);
    expect(await kv.get(kvKeys.family(familyId))).toBeNull();
  });

  it("should write NO tombstone when a non-owner tries to remove another member", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();

    const res = await removeMember(familyId, USER1, memberToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("NOT_OWNER");

    // A REFUSED removal must persist nothing: the caller holds no removal
    // authority at all, so a tombstone here would let any member ban any other.
    expect(await allTombstoneKeys()).toEqual([]);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER2]);
  });

  it("should write NO tombstone when the owner is refused their own exit", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();

    const res = await removeMember(familyId, USER1, ownerToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("OWNER_CANNOT_LEAVE");

    // Nothing was removed, and it was a self-leave regardless — a tombstone
    // would ban the owner from their own family over a request that failed.
    expect(await allTombstoneKeys()).toEqual([]);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER2]);
  });
});

// ===========================================================================
// POST /api/family/:id/join — what the tombstone refuses
// ===========================================================================

describe("POST /api/family/:id/join kicked tombstone gate", () => {
  it("should refuse the removed member's plain rejoin with 403 MEMBER_REMOVED", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    await removeMember(familyId, USER2, ownerToken);

    // Exactly what the removed client retries on its own: no secret, no token.
    const rejoinRes = await join(familyId, USER2);

    expect(rejoinRes.status).toBe(403);
    const json = (await rejoinRes.json()) as Json;
    expect(json.error.code).toBe("MEMBER_REMOVED");
    expect(json.error.message).toBe(MEMBER_REMOVED_MESSAGE);
    expect(json.data).toBeUndefined();

    // Fail-closed with no side effects: no token minted, no membership written.
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER2))).toBeNull();
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1]);
  });

  it("should keep refusing the rejoin however many times it is retried", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    await removeMember(familyId, USER2, ownerToken);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await join(familyId, USER2);
      expect(res.status).toBe(403);
      expect(((await res.json()) as Json).error.code).toBe("MEMBER_REMOVED");
    }

    expect(await memberIds(familyId, ownerToken)).toEqual([USER1]);
  });

  it("should admit the same rejoin once the tombstone has expired", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    await removeMember(familyId, USER2, ownerToken);
    expect((await join(familyId, USER2)).status).toBe(403);

    // The mock never expires anything; deleting the key IS the expiry model.
    await kv.delete(kvKeys.kicked(familyId, USER2));

    const rejoinRes = await join(familyId, USER2);
    expect(rejoinRes.status).toBe(200);
    const json = (await rejoinRes.json()) as Json;
    expect(json.data.authToken).toMatch(/^[a-f0-9]{64}$/);
    expect(json.data.familyId).toBe(familyId);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER2]);
  });

  it("should still admit a DIFFERENT user into the vacated seat while the tombstone lives", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    await removeMember(familyId, USER2, ownerToken);

    // The tombstone bans one userId from one family, it does not freeze the seat.
    const joinRes = await join(familyId, USER3);

    expect(joinRes.status).toBe(200);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER3]);
    // ...and USER2 is still out.
    expect((await join(familyId, USER2)).status).toBe(403);
  });

  it("should not stop the removed member from joining a DIFFERENT family", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    await removeMember(familyId, USER2, ownerToken);

    // The key is scoped per (family, user): being removed from one household
    // must not blacklist the account everywhere.
    const { familyId: otherFamilyId, authToken: otherOwnerToken } =
      await createFamily(USER3);
    const joinRes = await join(otherFamilyId, USER2);

    expect(joinRes.status).toBe(200);
    expect(await memberIds(otherFamilyId, otherOwnerToken)).toEqual([
      USER3,
      USER2,
    ]);
  });
});

// ===========================================================================
// DELETE /api/family/:id/member/:uid — idempotent re-kick on MEMBER_NOT_FOUND
//
// The removal writes are a `Promise.all`, so an attempt can half-fail: the
// member is dropped from the family record while the tombstone never lands.
// The owner's retry then finds nobody to remove and, before this branch
// existed, 404'd AHEAD of the tombstone block — the ban became unappliable and
// the silent auto-rejoin loop stayed open. Writing the tombstone on the way out
// of the 404 makes a kick re-assertable; the RESPONSE stays exactly as it was.
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid re-kick when the target is not a member", () => {
  it("should tombstone the target while still answering 404 MEMBER_NOT_FOUND", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    const ops = watchKvOps(kv);

    const res = await removeMember(familyId, USER3, ownerToken);

    // Unchanged response contract — the new write is invisible to the caller.
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MEMBER_NOT_FOUND");
    expect(json.error.message).toBe(MEMBER_NOT_FOUND_MESSAGE);

    const tombstone = await readTombstone(familyId, USER3);
    expect(tombstone).not.toBeNull();
    expect(tombstone!.removedBy).toBe(USER1);
    expect(Number.isNaN(Date.parse(tombstone!.removedAt))).toBe(false);
    // Same bounded lifetime as the post-removal write, from the same helper.
    expect(getPutTtl(kv, kvKeys.kicked(familyId, USER3))).toBe(
      KICKED_TOMBSTONE_TTL_SECONDS,
    );

    // The tombstone is the ONLY write. An error path must not touch the family
    // record, and the sitting members stay untouched.
    expect(ops.writeTrail()).toEqual([`put ${kvKeys.kicked(familyId, USER3)}`]);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER2]);
  });

  it("should refuse the re-kicked userId's next join with 403 MEMBER_REMOVED", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    expect((await removeMember(familyId, USER3, ownerToken)).status).toBe(404);

    // The whole point of writing on the 404 path: the ban must actually bite.
    // USER3 never joined here, which also pins the accepted consequence — an
    // owner may pre-tombstone a userId, scoped to their own family and squarely
    // inside the authority they already have to remove anyone from it.
    const joinRes = await join(familyId, USER3);

    expect(joinRes.status).toBe(403);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.error.code).toBe("MEMBER_REMOVED");
    expect(joinJson.error.message).toBe(MEMBER_REMOVED_MESSAGE);
    expect(await kv.get(kvKeys.member(USER3))).toBeNull();
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER2]);
  });

  it("should write NO tombstone when a non-member targets themselves", async () => {
    const { familyId } = await createFamilyWithTwoMembers();
    // A caller holding a live token who is not in THIS family — a stale client
    // retrying its own leave after it already moved on. Owning another family
    // is simply the cheapest way through the public API to hold such a token.
    const { authToken: outsiderToken } = await createFamily(USER3);

    const res = await removeMember(familyId, USER3, outsiderToken);

    expect(res.status).toBe(404);
    expect(((await res.json()) as Json).error.code).toBe("MEMBER_NOT_FOUND");
    // `targetUserId === callerId` is never a kick, on this path as on the
    // successful one: a self-directed request must not tombstone anybody.
    expect(await allTombstoneKeys()).toEqual([]);
  });
});

// ===========================================================================
// Tombstone write failure — fail open
//
// Both call sites swallow a failed put, log it, and answer as though it had
// never been attempted: after a successful removal, reporting the DELETE as
// failed would be a lie (the member IS gone); on the MEMBER_NOT_FOUND path the
// response is already an error. A missing tombstone only degrades to the
// previous, weaker behaviour — and the owner's next DELETE re-attempts the
// write through the idempotent re-kick path, so the ban is recoverable rather
// than lost for good.
// ===========================================================================

describe("Tombstone write failure", () => {
  it("should still remove the member and answer 200 when the tombstone write throws", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failPutFor(kvKeys.kicked(familyId, USER2));

    const res = await removeMember(familyId, USER2, ownerToken);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members).toEqual([
      { userId: USER1, displayName: "", canLend: 1 },
    ]);
    // The removal itself is complete and durable...
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1]);
    // ...only the tombstone is missing, and the failure is observable in logs.
    expect(await readTombstone(familyId, USER2)).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      "KICK_TOMBSTONE_WRITE_FAILED",
      expect.objectContaining({ familyId, targetUserId: USER2 }),
    );
  });

  it("should degrade to the pre-tombstone behaviour when the write failed", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    failPutFor(kvKeys.kicked(familyId, USER2));
    await removeMember(familyId, USER2, ownerToken);

    // Documented consequence of failing open: with no tombstone the removed
    // client can rejoin again. Pinned so the trade-off stays visible rather
    // than being mistaken for enforcement that silently never ran.
    const rejoinRes = await join(familyId, USER2);

    expect(rejoinRes.status).toBe(200);
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1, USER2]);
  });

  it("should answer a plain 404 when the re-kick write throws", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failPutFor(kvKeys.kicked(familyId, USER3));

    const res = await removeMember(familyId, USER3, ownerToken);

    // Byte-identical to the 404 a healthy write produces: the failure must not
    // become a 500, and the caller learns nothing about the tombstone either way.
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MEMBER_NOT_FOUND");
    expect(json.error.message).toBe(MEMBER_NOT_FOUND_MESSAGE);

    expect(await readTombstone(familyId, USER3)).toBeNull();
    expect(errors).toHaveBeenCalledWith(
      "KICK_TOMBSTONE_WRITE_FAILED",
      expect.objectContaining({ familyId, targetUserId: USER3 }),
    );
  });

  it("should let the owner's retry re-apply a ban whose tombstone was lost", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const restoreKv = failPutFor(kvKeys.kicked(familyId, USER2));
    expect((await removeMember(familyId, USER2, ownerToken)).status).toBe(200);
    expect(await readTombstone(familyId, USER2)).toBeNull();
    restoreKv();

    // USER2 is already out of the member list, so the retry lands on the
    // MEMBER_NOT_FOUND path — which is precisely why that path must write.
    const retryRes = await removeMember(familyId, USER2, ownerToken);

    expect(retryRes.status).toBe(404);
    expect(((await retryRes.json()) as Json).error.code).toBe(
      "MEMBER_NOT_FOUND",
    );
    expect((await readTombstone(familyId, USER2))?.removedBy).toBe(USER1);
    expect(getPutTtl(kv, kvKeys.kicked(familyId, USER2))).toBe(
      KICKED_TOMBSTONE_TTL_SECONDS,
    );

    // ...and the rejoin the lost tombstone had left open is refused again.
    const rejoinRes = await join(familyId, USER2);
    expect(rejoinRes.status).toBe(403);
    expect(((await rejoinRes.json()) as Json).error.code).toBe(
      "MEMBER_REMOVED",
    );
    expect(await memberIds(familyId, ownerToken)).toEqual([USER1]);
  });
});
