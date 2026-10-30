import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { expectRevokeIndexOrder } from "../helpers/auth";
import { ALICE, BOB } from "../helpers/ids";
import { readAuthRecord } from "../../src/services/authRecord";
import { mintAuthToken, type IssuedToken } from "../../src/services/authTokens";
import { hashAuthToken } from "../../src/utils/crypto";
import { kvKeys } from "../../src/kv/schema";

/**
 * Revoke-all must reach an ORPHAN token (#431).
 *
 * `mintAuthToken(kv, userId, knownAuth)` rewrites `auth:{userId}` from the
 * caller's `knownAuth` read plus the new hash. Two mints that start from the
 * SAME stale read (two devices joining in the same KV read window) each write
 * their own `token:{hash}`, but the second `auth:` put overwrites the first:
 * the first token is an orphan — its `token:{hash}` is live, so the auth
 * middleware accepts it, yet no `auth:` list names it. Revoke-all
 * (`revokeAuthTokenKeys` / `revokeAllAuthTokens` / `readAndRevokeAllAuthTokens`
 * in `src/services/authTokens.ts`) deletes only the keys `auth:` names, so the
 * orphan survives a PIN save, leaving the family and deleting the account, and
 * keeps answering 200 until its 90-day TTL runs out.
 *
 * Each case builds the orphan with two production mints from one `auth` read,
 * pins that precondition (orphan key live and unlisted, the second token
 * listed), proves both bearers are accepted before the revoke, then drives one
 * revoke-all entry point with the CURRENT token and expects the orphan to be
 * refused with 401. This file is the red-before / green-after check for #431:
 * on the pre-fix code the three final 401 assertions receive 200.
 *
 * ALICE joins BOB's family, so she is a non-owner: leaving is allowed and
 * deleting the account takes the settle-and-put branch. She has no PIN, so
 * neither the PIN save nor the delete needs a current-secret step-up. Every
 * request runs with DEV_MODE (rate limits are not under test).
 *
 * Revoke-then-mint order (R6): a PIN save revokes every token and then mints
 * the saving device a new one. The revoke must list `tokenidx:{userId}:`
 * BEFORE the new token's index is put, or it could revoke the token it is
 * about to hand out; the last case pins that on the full write trail.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER_ID = ALICE;
const OWNER_ID = BOB;
const PIN = "123456";

let kv: KVNamespace;

async function request(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

function readBooks(token: string): Promise<Response> {
  return request("GET", `/api/user/${USER_ID}/books`, token);
}

async function joinOwnersFamily(): Promise<string> {
  const created = await request("POST", "/api/family", undefined, {
    userId: OWNER_ID,
  });
  expect(created.status).toBe(201);
  const familyId = ((await created.json()) as Json).data.familyId as string;
  const joined = await request(
    "POST",
    `/api/family/${familyId}/join`,
    undefined,
    { userId: USER_ID },
  );
  expect(joined.status).toBe(200);
  return familyId;
}

/** Two mints from one stale `auth` read: `orphan` is live but unlisted, `current` is listed. */
async function mintOrphan(): Promise<{
  orphan: IssuedToken;
  current: IssuedToken;
}> {
  const auth = await readAuthRecord(kv, USER_ID);
  const orphan = await mintAuthToken(kv, USER_ID, auth);
  const current = await mintAuthToken(kv, USER_ID, auth);

  const orphanHash = await hashAuthToken(orphan.token);
  const listed = ((await readAuthRecord(kv, USER_ID))?.tokens ?? []).map(
    (entry) => entry.hash,
  );
  expect(await kv.get(kvKeys.authToken(orphanHash))).not.toBeNull();
  expect(listed).not.toContain(orphanHash);
  expect(listed).toContain(await hashAuthToken(current.token));
  return { orphan, current };
}

/** Both bearers authenticate before the revoke, so a later 401 comes from the revoke. */
async function expectBothAccepted(
  orphan: IssuedToken,
  current: IssuedToken,
): Promise<void> {
  expect((await readBooks(current.token)).status).toBe(200);
  expect((await readBooks(orphan.token)).status).toBe(200);
}

async function expectRefused(token: string): Promise<void> {
  const res = await readBooks(token);
  expect(res.status).toBe(401);
  expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revoke-all — an orphan token left by two mints from one stale read", () => {
  it("is refused after a PIN save (PUT /api/user/:id/verify)", async () => {
    await joinOwnersFamily();
    const { orphan, current } = await mintOrphan();
    await expectBothAccepted(orphan, current);

    const res = await request(
      "PUT",
      `/api/user/${USER_ID}/verify`,
      current.token,
      { method: "pin", secret: PIN },
    );
    expect(res.status).toBe(200);

    await expectRefused(orphan.token);
  });

  it("is refused after leaving the family (DELETE /api/family/:id/member/:uid)", async () => {
    const familyId = await joinOwnersFamily();
    const { orphan, current } = await mintOrphan();
    await expectBothAccepted(orphan, current);

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/${USER_ID}`,
      current.token,
    );
    expect(res.status).toBe(200);

    await expectRefused(orphan.token);
  });

  it("is refused after deleting the account (DELETE /api/user/:id)", async () => {
    await joinOwnersFamily();
    const { orphan, current } = await mintOrphan();
    await expectBothAccepted(orphan, current);

    const res = await request("DELETE", `/api/user/${USER_ID}`, current.token);
    expect(res.status).toBe(200);

    await expectRefused(orphan.token);
  });

  it("lists the index before the new token's index is put, so only the new token survives a PIN save", async () => {
    await joinOwnersFamily();
    const { orphan, current } = await mintOrphan();
    const joined = (await readAuthRecord(kv, USER_ID))!.tokens[0].hash;
    const ops = watchKvOps(kv);

    const res = await request(
      "PUT",
      `/api/user/${USER_ID}/verify`,
      current.token,
      { method: "pin", secret: PIN },
    );
    expect(res.status).toBe(200);
    const issued = ((await res.json()) as Json).data.authToken as string;

    const index = (hash: string) => kvKeys.authTokenIndex(USER_ID, hash);
    const [orphanHash, currentHash, newHash] = await Promise.all(
      [orphan.token, current.token, issued].map(hashAuthToken),
    );
    const listEntry = `list ${index("")}`;
    const trail = ops.writeTrail();
    expect([...trail].sort()).toEqual(
      [
        `put ${kvKeys.verify(USER_ID)}`,
        listEntry,
        `delete ${kvKeys.otp(USER_ID)}`,
        ...[joined, orphanHash, currentHash].flatMap((h) => [
          `delete ${kvKeys.authToken(h)}`,
          `delete ${index(h)}`,
        ]),
        `put ${index(newHash)}`,
        `put ${kvKeys.auth(USER_ID)}`,
        `put ${kvKeys.authToken(newHash)}`,
      ].sort(),
    );
    expectRevokeIndexOrder(trail, USER_ID);
    expect(trail.indexOf(listEntry)).toBeLessThan(
      trail.indexOf(`put ${index(newHash)}`),
    );
    expect(trail.slice(-3)).toEqual([
      `put ${index(newHash)}`,
      `put ${kvKeys.auth(USER_ID)}`,
      `put ${kvKeys.authToken(newHash)}`,
    ]);

    const left = await kv.list({ prefix: index("") });
    expect(left.keys.map((k) => k.name)).toEqual([index(newHash)]);
    expect((await readBooks(issued)).status).toBe(200);
    await expectRefused(orphan.token);
    await expectRefused(current.token);
  });
});
