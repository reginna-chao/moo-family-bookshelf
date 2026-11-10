import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { listsToken, seedAuthToken, tokenOwner } from "../helpers/auth";
import { USER1, USER2, USER3 } from "../helpers/ids";
import {
  kvKeys,
  TOKEN_TTL_SECONDS,
  type AuthTokenRecord,
  type FamilyRecord,
} from "../../src/kv/schema";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * A pending one-time code does not outlive a departure.
 *
 * An account on the `code` verification method proves itself on a new device
 * with a six-digit code that a device holding a current token mints through
 * `POST /api/user/:id/verify/otp` (`otp:{userId}`, 5-minute TTL). Leaving the
 * family, being removed by the owner, or dissolving it ends every session of
 * the account; the pending code is ended with them, so it cannot open a new
 * one afterwards. `DELETE /api/family/:id/member/:uid` reaches that through
 * four branches, one case each:
 *
 * - an ordinary self-leave (T1) and an owner kick (T2): the code is refused by
 *   a later join / create with `403 VERIFICATION_FAILED`, and `otp:` is gone;
 * - the active sole owner leaving, which dissolves the family (T3);
 * - the `404 MEMBER_NOT_FOUND` stray-pointer cleanup of a retried self-leave
 *   (T4): unlisted, but `member:{uid}` still names this family;
 * - a self-leave that empties the member list and dissolves (T7): the list
 *   holds only a non-owner, `ownerId` names someone no longer listed.
 *
 * A self-leave also revokes the token it presents, even one that is neither on
 * `auth:{userId}`'s list nor indexed under `tokenidx:{userId}:` (T5). That is
 * reachable only while the account has no `auth:{userId}` record (the TTL gap),
 * where any live bearer counts as current: with a list in place, an unlisted
 * bearer is refused `401 UNAUTHORIZED` before the family record is read, and
 * nothing is written or revoked (T5b; `enforceCallerCurrentSecret` in
 * `worker/src/services/currentSecretStepUp.ts`). An owner kick never revokes
 * the owner's own token (T6).
 *
 * Every account is put on the `code` method through its own token
 * (`PUT /api/user/:id/verify`), and every code is minted through the API, so
 * the cases drive production paths only. Requests run with DEV_MODE: no rate
 * limit is under test. The store is a fresh `createMockKV()` per case.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return Promise.resolve(app.request(path, init, { KV: kv, DEV_MODE: "1" }));
}

async function createFamily(
  userId: string,
): Promise<{ familyId: string; token: string }> {
  const res = await request("POST", "/api/family", { userId });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return { familyId: json.data.familyId, token: json.data.authToken };
}

async function joinFamily(familyId: string, userId: string): Promise<string> {
  const res = await request("POST", `/api/family/${familyId}/join`, {
    userId,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

/** USER1 owns the family, USER2 is an ordinary member. */
async function createFamilyWithTwoMembers() {
  const { familyId, token: ownerToken } = await createFamily(USER1);
  const memberToken = await joinFamily(familyId, USER2);
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

/** Switch `userId` to the `code` method with its own token, mint a code, and
 *  return it; pins that `otp:{userId}` holds it. */
async function mintPendingCode(userId: string, token: string): Promise<string> {
  const set = await request(
    "PUT",
    `/api/user/${userId}/verify`,
    { method: "code" },
    token,
  );
  expect(set.status).toBe(200);
  const res = await request(
    "POST",
    `/api/user/${userId}/verify/otp`,
    undefined,
    token,
  );
  expect(res.status).toBe(200);
  const code = ((await res.json()) as Json).data.code as string;
  expect(code).toMatch(/^\d{6}$/);
  expect(await kv.get(kvKeys.otp(userId), "json")).toMatchObject({ code });
  return code;
}

async function expectErrorCode(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as Json).error.code).toBe(code);
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/family/:id/member/:uid — a pending one-time code does not outlive a departure", () => {
  it("refuses the code a member minted before leaving the family (T1)", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    const code = await mintPendingCode(USER2, memberToken);

    expect((await removeMember(familyId, USER2, memberToken)).status).toBe(200);

    expect(await kv.get(kvKeys.otp(USER2))).toBeNull();
    const rejoin = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      verifySecret: code,
    });
    await expectErrorCode(rejoin, 403, "VERIFICATION_FAILED");
  });

  it("refuses the code a member minted before the owner removed them (T2)", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    const code = await mintPendingCode(USER2, memberToken);

    expect((await removeMember(familyId, USER2, ownerToken)).status).toBe(200);

    expect(await kv.get(kvKeys.otp(USER2))).toBeNull();
    const create = await request("POST", "/api/family", {
      userId: USER2,
      verifySecret: code,
    });
    await expectErrorCode(create, 403, "VERIFICATION_FAILED");
  });

  it("ends the sole owner's pending code when their leave dissolves the family (T3)", async () => {
    const { familyId, token } = await createFamily(USER1);
    await mintPendingCode(USER1, token);

    expect((await removeMember(familyId, USER1, token)).status).toBe(200);

    expect(await kv.get(kvKeys.family(familyId))).toBeNull();
    expect(await kv.get(kvKeys.otp(USER1))).toBeNull();
  });

  it("ends the pending code on a retried self-leave whose pointer still names the family (T4)", async () => {
    const { familyId } = await createFamily(USER1);
    // Stale-pointer state: a live token and a pointer at this family, but unlisted.
    const staleToken = await seedAuthToken(kv, USER3);
    await kv.put(kvKeys.member(USER3), familyId);
    await mintPendingCode(USER3, staleToken);

    const res = await removeMember(familyId, USER3, staleToken);

    await expectErrorCode(res, 404, "MEMBER_NOT_FOUND");
    expect(await kv.get(kvKeys.member(USER3))).toBeNull();
    expect(await kv.get(kvKeys.otp(USER3))).toBeNull();
  });

  it("ends the pending code when a self-leave empties the member list and dissolves (T7)", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();
    await mintPendingCode(USER2, memberToken);
    // The list holds only USER2; `ownerId` still names the no-longer-listed USER1.
    const record = (await kv.get<FamilyRecord>(
      kvKeys.family(familyId),
      "json",
    ))!;
    await kv.put(
      kvKeys.family(familyId),
      JSON.stringify({
        ...record,
        members: record.members.filter((m) => m.userId === USER2),
      }),
    );

    const res = await removeMember(familyId, USER2, memberToken);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data).toEqual({ ok: true });
    expect(await kv.get(kvKeys.family(familyId))).toBeNull();
    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await kv.get(kvKeys.otp(USER2))).toBeNull();
  });
});

/** Put only the `token:` half of a USER2 token — no `tokenidx:` key, no `auth:` list entry — and return it. */
async function seedUnindexedToken(): Promise<{
  presented: string;
  hash: string;
}> {
  const presented = "e".repeat(64);
  const createdAt = new Date().toISOString();
  const tokenRecord: AuthTokenRecord = {
    userId: USER2,
    createdAt,
    expiresAt: Date.parse(createdAt) + TOKEN_TTL_SECONDS * 1000,
  };
  const hash = await hashAuthToken(presented);
  await kv.put(kvKeys.authToken(hash), JSON.stringify(tokenRecord));
  expect(await listsToken(kv, USER2, presented)).toBe(false);
  expect(await kv.get(kvKeys.authTokenIndex(USER2, hash))).toBeNull();
  expect(await tokenOwner(kv, presented)).toBe(USER2);
  return { presented, hash };
}

describe("DELETE /api/family/:id/member/:uid — which tokens a departure revokes", () => {
  it("revokes the presented token on a self-leave even when it is neither listed nor indexed (T5)", async () => {
    const { familyId } = await createFamilyWithTwoMembers();
    // TTL gap: with no `auth:{USER2}` record, an unlisted bearer still counts as current.
    await kv.delete(kvKeys.auth(USER2));
    expect(await kv.get(kvKeys.auth(USER2))).toBeNull();
    const { presented, hash } = await seedUnindexedToken();

    expect((await removeMember(familyId, USER2, presented)).status).toBe(200);

    expect(await kv.get(kvKeys.member(USER2))).toBeNull();
    expect(await kv.get(kvKeys.authToken(hash))).toBeNull();
  });

  it("refuses a self-leave whose token is off an existing list, changing nothing (T5b)", async () => {
    const { familyId } = await createFamilyWithTwoMembers();
    expect(await kv.get(kvKeys.auth(USER2))).not.toBeNull();
    const { presented, hash } = await seedUnindexedToken();
    const familyBefore = await kv.get(kvKeys.family(familyId));
    const tokenBefore = await kv.get(kvKeys.authToken(hash));
    expect(familyBefore).toContain(USER2);

    const res = await removeMember(familyId, USER2, presented);

    await expectErrorCode(res, 401, "UNAUTHORIZED");
    expect(await kv.get(kvKeys.family(familyId))).toBe(familyBefore);
    expect(await kv.get(kvKeys.member(USER2))).toBe(familyId);
    expect(await kv.get(kvKeys.authToken(hash))).toBe(tokenBefore);
  });

  it("keeps the owner's own token alive after the owner removes a member (T6)", async () => {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();

    expect((await removeMember(familyId, USER2, ownerToken)).status).toBe(200);

    // Positive companion: the removed member's token is gone.
    expect(await tokenOwner(kv, memberToken)).toBeNull();
    expect(await tokenOwner(kv, ownerToken)).toBe(USER1);
  });
});
