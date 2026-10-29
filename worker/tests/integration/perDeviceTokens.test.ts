import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken, seedLegacyAuthToken } from "../helpers/auth";
import { ALICE, BOB } from "../helpers/ids";
import { hashAuthToken, hashSecret } from "../../src/utils/crypto";
import {
  kvKeys,
  type StoredAuthRecord,
  type VerifyRecord,
} from "../../src/kv/schema";

/**
 * One token per device (#425), end to end through the Hono app.
 *
 * Every join mints: two reconnects of the same account hand out two different
 * tokens, and both keep authenticating — the old "a reconnect returns the
 * account's one token" behaviour is gone on purpose.
 *
 * Revoke-all: a PIN / pattern save (`PUT /api/user/:id/verify`), leaving the
 * family, being kicked, dissolving it and deleting the account each revoke
 * EVERY token of the account, not only the presented one. The PIN save then
 * mints one new token for the saving device: `auth:{userId}` is put exactly
 * once and never deleted in that request (KV allows one write per key per
 * second, so a delete-then-put could drop the new list), and carries
 * `secretAt` = the new verify record's `secretUpdatedAt`.
 *
 * QR: the Extension's token mints a QR, the PWA redeems it, and the PWA gets
 * its OWN token — the Extension's keeps working. A QR whose minting token is
 * no longer listed, or is listed but its `token:` key is gone, does not skip
 * verification (`403 VERIFICATION_REQUIRED` on a PIN account).
 *
 * "Does this token still work" is probed with the owner-only
 * `GET /api/user/:id/books`. Every request runs with DEV_MODE (rate limits are
 * not under test).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER_ID = ALICE;
const OWNER_ID = BOB;
const FAMILY_ID = "abcd-1234";
const PIN = "123456";
const SALT = "ab".repeat(16);
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const OWNER_TOKEN = "d".repeat(64);
const HEX_64 = /^[a-f0-9]{64}$/;

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

function readBooks(userId: string, token: string): Promise<Response> {
  return request("GET", `/api/user/${userId}/books`, token);
}

function join(extra: Record<string, unknown> = {}): Promise<Response> {
  return request("POST", `/api/family/${FAMILY_ID}/join`, undefined, {
    userId: USER_ID,
    ...extra,
  });
}

async function joinedToken(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

async function seedFamily(members: string[]): Promise<void> {
  for (const userId of members) {
    await kv.put(kvKeys.member(userId), FAMILY_ID);
  }
  await kv.put(
    kvKeys.family(FAMILY_ID),
    JSON.stringify({
      familyId: FAMILY_ID,
      ownerId: OWNER_ID,
      members: members.map((userId) => ({ userId, displayName: "Member" })),
      maxMembers: 2,
      createdAt: new Date().toISOString(),
    }),
  );
}

async function seedPin(): Promise<void> {
  const record: VerifyRecord = {
    method: "pin",
    hash: await hashSecret(SALT, PIN),
    salt: SALT,
    prompted: 1,
  };
  await kv.put(kvKeys.verify(USER_ID), JSON.stringify(record));
}

/** Two devices of USER_ID: TOKEN_A then TOKEN_B on one list. */
async function seedTwoDevices(): Promise<void> {
  await seedAuthToken(kv, USER_ID, { token: TOKEN_A });
  await seedAuthToken(kv, USER_ID, { token: TOKEN_B, appendTo: true });
}

async function storedAuth(userId = USER_ID): Promise<StoredAuthRecord | null> {
  return kv.get<StoredAuthRecord>(kvKeys.auth(userId), "json");
}

async function expectRevoked(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    expect(
      await kv.get(kvKeys.authToken(await hashAuthToken(token))),
    ).toBeNull();
    expect((await readBooks(USER_ID, token)).status).toBe(401);
  }
  expect(await storedAuth()).toBeNull();
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("per-device tokens — every join mints", () => {
  it("hands two reconnects of one account two different tokens, both valid", async () => {
    await seedFamily([OWNER_ID, USER_ID]);

    const first = await joinedToken(await join());
    const second = await joinedToken(await join());

    expect(first).toMatch(HEX_64);
    expect(second).toMatch(HEX_64);
    expect(second).not.toBe(first);
    expect((await readBooks(USER_ID, first)).status).toBe(200);
    expect((await readBooks(USER_ID, second)).status).toBe(200);
    expect((await storedAuth())?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(first),
      await hashAuthToken(second),
    ]);
  });
});

describe("per-device tokens — a PIN save revokes every device", () => {
  it("logs out both devices, lists only the new token with secretAt, and puts auth: once", async () => {
    await seedTwoDevices();
    const ops = watchKvOps(kv);

    const res = await request("PUT", `/api/user/${USER_ID}/verify`, TOKEN_A, {
      method: "pin",
      secret: PIN,
    });
    expect(res.status).toBe(200);
    const issued = ((await res.json()) as Json).data.authToken as string;

    expect(
      ops.putKeys().filter((k) => k === kvKeys.auth(USER_ID)),
    ).toHaveLength(1);
    expect(ops.deleteKeys()).not.toContain(kvKeys.auth(USER_ID));
    expect((await readBooks(USER_ID, TOKEN_A)).status).toBe(401);
    expect((await readBooks(USER_ID, TOKEN_B)).status).toBe(401);
    expect((await readBooks(USER_ID, issued)).status).toBe(200);
    const verify = await kv.get<VerifyRecord>(kvKeys.verify(USER_ID), "json");
    const auth = await storedAuth();
    expect(auth?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(issued),
    ]);
    expect(auth?.secretAt).toBe(verify?.secretUpdatedAt);
    expect(typeof auth?.secretAt).toBe("number");
  });

  it("still revokes the presented token when there is no auth: record (TTL gap)", async () => {
    await seedAuthToken(kv, USER_ID, { token: TOKEN_A });
    await kv.delete(kvKeys.auth(USER_ID));

    const res = await request("PUT", `/api/user/${USER_ID}/verify`, TOKEN_A, {
      method: "pin",
      secret: PIN,
    });

    expect(res.status).toBe(200);
    expect(
      await kv.get(kvKeys.authToken(await hashAuthToken(TOKEN_A))),
    ).toBeNull();
    expect((await readBooks(USER_ID, TOKEN_A)).status).toBe(401);
  });

  it.each(["none", "code"])(
    "keeps every device logged in on a %s save",
    async (method) => {
      await seedTwoDevices();

      const res = await request("PUT", `/api/user/${USER_ID}/verify`, TOKEN_A, {
        method,
      });

      expect(res.status).toBe(200);
      expect((await readBooks(USER_ID, TOKEN_A)).status).toBe(200);
      expect((await readBooks(USER_ID, TOKEN_B)).status).toBe(200);
    },
  );
});

describe("per-device tokens — departures revoke every device", () => {
  it("self-leave revokes both of the leaver's tokens", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedTwoDevices();

    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${USER_ID}`,
      TOKEN_A,
    );

    expect(res.status).toBe(200);
    await expectRevoked([TOKEN_A, TOKEN_B]);
  });

  it("a kick revokes both of the target's tokens and leaves the owner's", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedTwoDevices();
    await seedAuthToken(kv, OWNER_ID, { token: OWNER_TOKEN });

    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${USER_ID}`,
      OWNER_TOKEN,
    );

    expect(res.status).toBe(200);
    await expectRevoked([TOKEN_A, TOKEN_B]);
    expect((await readBooks(OWNER_ID, OWNER_TOKEN)).status).toBe(200);
  });

  it("a sole owner's dissolve revokes both of the owner's tokens", async () => {
    await seedFamily([OWNER_ID]);
    const ownerA = await seedAuthToken(kv, OWNER_ID, { token: TOKEN_A });
    const ownerB = await seedAuthToken(kv, OWNER_ID, {
      token: TOKEN_B,
      appendTo: true,
    });

    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${OWNER_ID}`,
      ownerA,
    );

    expect(res.status).toBe(200);
    for (const token of [ownerA, ownerB]) {
      expect(
        await kv.get(kvKeys.authToken(await hashAuthToken(token))),
      ).toBeNull();
      expect((await readBooks(OWNER_ID, token)).status).toBe(401);
    }
    expect(await storedAuth(OWNER_ID)).toBeNull();
  });

  it("DELETE /api/user/:id revokes both of the account's tokens", async () => {
    await seedTwoDevices();

    const res = await request("DELETE", `/api/user/${USER_ID}`, TOKEN_A);

    expect(res.status).toBe(200);
    await expectRevoked([TOKEN_A, TOKEN_B]);
  });

  it("DELETE /api/user/:id revokes a pre-#425 plaintext bearer with no auth: record", async () => {
    await seedLegacyAuthToken(kv, USER_ID, TOKEN_A);
    await kv.delete(kvKeys.auth(USER_ID));
    expect((await readBooks(USER_ID, TOKEN_A)).status).toBe(200);

    const res = await request("DELETE", `/api/user/${USER_ID}`, TOKEN_A);

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.authToken(TOKEN_A))).toBeNull();
    expect((await readBooks(USER_ID, TOKEN_A)).status).toBe(401);
  });
});

describe("per-device tokens — QR redeem", () => {
  async function mintQr(token: string): Promise<string> {
    const res = await request(
      "POST",
      `/api/user/${USER_ID}/qr-token`,
      token,
      {},
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as Json).data.token as string;
  }

  beforeEach(async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedPin();
  });

  it("gives the PWA its own token and keeps the Extension's", async () => {
    const extension = await seedAuthToken(kv, USER_ID, { token: TOKEN_A });
    const qr = await mintQr(extension);

    const pwa = await joinedToken(await join({ qrToken: qr }));

    expect(pwa).toMatch(HEX_64);
    expect(pwa).not.toBe(extension);
    expect((await readBooks(USER_ID, extension)).status).toBe(200);
    expect((await readBooks(USER_ID, pwa)).status).toBe(200);
    expect((await storedAuth())?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(extension),
      await hashAuthToken(pwa),
    ]);
  });

  it("does not skip verification once the minting token is off the list", async () => {
    const extension = await seedAuthToken(kv, USER_ID, { token: TOKEN_A });
    const qr = await mintQr(extension);
    await seedAuthToken(kv, USER_ID, { token: TOKEN_B }); // the list now holds TOKEN_B alone

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe(
      "VERIFICATION_REQUIRED",
    );
  });

  it("refuses when the minting token is listed but its token: key is gone", async () => {
    const extension = await seedAuthToken(kv, USER_ID, { token: TOKEN_A });
    const qr = await mintQr(extension);
    await kv.delete(kvKeys.authToken(await hashAuthToken(extension)));
    const ops = watchKvOps(kv);

    const res = await join({ qrToken: qr });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe(
      "VERIFICATION_REQUIRED",
    );
    // Only the spent QR is written; no token is minted.
    expect(ops.writeTrail()).toEqual([`delete ${kvKeys.qrToken(qr)}`]);
  });

  it("still lets the correct PIN through after a QR that cannot bypass", async () => {
    const extension = await seedAuthToken(kv, USER_ID, { token: TOKEN_A });
    const qr = await mintQr(extension);
    await seedAuthToken(kv, USER_ID, { token: TOKEN_B });

    const res = await join({ qrToken: qr, verifySecret: PIN });

    expect(res.status).toBe(200);
  });
});
