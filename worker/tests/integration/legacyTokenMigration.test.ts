import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken, seedLegacyAuthToken } from "../helpers/auth";
import { ALICE, BOB } from "../helpers/ids";
import { readAuthRecord } from "../../src/services/authRecord";
import {
  mintAuthToken,
  readAndRevokeAllAuthTokens,
} from "../../src/services/authTokens";
import { hashAuthToken } from "../../src/utils/crypto";
import {
  kvKeys,
  TOKEN_TTL_SECONDS,
  type AuthTokenRecord,
} from "../../src/kv/schema";

/**
 * The pre-#425 plaintext token keeps working and is migrated silently.
 *
 * Old shape (`seedLegacyAuthToken`): `token:{T}` → userId as bare text, and
 * `auth:{userId}` → `{ token: T, createdAt, secretAt? }`. It normalizes to
 * `{ tokens: [], legacyToken: T }` (secretAt kept). Until the account's next
 * refresh or mint, the middleware accepts T through a fallback read of
 * `token:{T}` that runs only when `token:{hash(T)}` misses — and only for a
 * 64-hex value, so presenting a #425 token's HASH as a bearer is refused. The
 * fallback also reads `auth:{userId}` and accepts T only while that record is
 * the legacy shape naming T (C5): a plaintext key with no such record — no
 * record, a #425 list, or a legacy record naming another token — is inert.
 *
 * Refresh with T migrates in place: the same string comes back,
 * `token:{hash(T)}` is written, `token:{T}` deleted, and `auth:` becomes the
 * #425 list (`legacyToken` / `token` never reach KV). Any other mint for the
 * account (another device joining) migrates T the same way without logging it
 * out. A plaintext token the old record does NOT name (an orphan of the old
 * one-token model) is refused by the middleware: refresh answers
 * `401 UNAUTHORIZED`. A revoke-all also deletes the plaintext key.
 *
 * A plaintext key left behind by a failed migration delete is inert (C5): the
 * migration deletes `token:{T}` last, so the leftover is modelled by putting
 * it back after a completed mint. No `auth:` record names it any more, so once
 * a revoke-all drops `token:{hash(T)}`, T answers 401 — refresh included — and
 * nothing is written for it.
 *
 * A revoked legacy token is never revived (C3): a PIN save deletes
 * `token:{T}`, but a colo that missed its `auth:` write still serves the old
 * `{ token: T }` record. A correct-PIN join there mints from that stale read;
 * since `token:{T}` is gone the migration drops T — no `token:{hash(T)}`, no
 * list entry — so T stays logged out. The stale colo is modelled by putting
 * the old record back after the PIN save (no `secretAt`, as before #378).
 *
 * Every request runs with DEV_MODE (rate limits are not under test).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER_ID = ALICE;
const OWNER_ID = BOB;
const FAMILY_ID = "abcd-1234";
const LEGACY = "c".repeat(64);
const ORPHAN = "e".repeat(64);
const SECRET_AT = 1_767_225_600_000;
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

function refresh(token: string): Promise<Response> {
  return request("POST", "/api/auth/refresh", token, { userId: USER_ID });
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

async function hashedRecord(token: string): Promise<AuthTokenRecord | null> {
  return kv.get<AuthTokenRecord>(
    kvKeys.authToken(await hashAuthToken(token)),
    "json",
  );
}

async function storedAuthRaw(): Promise<Record<string, unknown> | null> {
  return kv.get<Record<string, unknown>>(kvKeys.auth(USER_ID), "json");
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("legacy token — reading the old shape", () => {
  it.each([
    { label: "with secretAt", secretAt: SECRET_AT },
    { label: "without secretAt", secretAt: undefined },
  ])(
    "normalizes to an empty list plus legacyToken, $label",
    async ({ secretAt }) => {
      await seedLegacyAuthToken(kv, USER_ID, LEGACY, secretAt);

      expect(await readAuthRecord(kv, USER_ID)).toStrictEqual({
        tokens: [],
        legacyToken: LEGACY,
        ...(secretAt !== undefined && { secretAt }),
      });
    },
  );

  it("still authenticates the plaintext token through the fallback", async () => {
    await seedLegacyAuthToken(kv, USER_ID, LEGACY);
    const ops = watchKvOps(kv);

    expect((await readBooks(LEGACY)).status).toBe(200);

    expect(ops.getKeys().slice(0, 2)).toEqual([
      kvKeys.authToken(await hashAuthToken(LEGACY)),
      kvKeys.authToken(LEGACY),
    ]);
  });

  it("does not read the plaintext key for a hashed token", async () => {
    const token = await seedAuthToken(kv, USER_ID);
    const ops = watchKvOps(kv);

    expect((await readBooks(token)).status).toBe(200);

    expect(ops.getKeys()).not.toContain(kvKeys.authToken(token));
  });
});

describe("legacy token — middleware refusals", () => {
  it.each([
    { label: "a number", userId: 42 },
    { label: "missing", userId: undefined },
    { label: "an empty string", userId: "" },
  ])("answers 401 when token:{hash}'s userId is $label", async ({ userId }) => {
    const token = "f".repeat(64);
    await kv.put(
      kvKeys.authToken(await hashAuthToken(token)),
      JSON.stringify({
        userId,
        createdAt: new Date().toISOString(),
        expiresAt: 0,
      }),
    );

    const res = await readBooks(token);

    expect(res.status).toBe(401);
    expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
  });

  it.each([
    { label: "there is no auth: record", seedAuth: async () => {} },
    {
      label: "auth: is a #425 list",
      seedAuth: async () => {
        await seedAuthToken(kv, USER_ID, { token: "d".repeat(64) });
      },
    },
    {
      label: "the legacy auth: names another token",
      seedAuth: async () => {
        await seedLegacyAuthToken(kv, USER_ID, ORPHAN);
      },
    },
  ])("refuses a live plaintext key when $label", async ({ seedAuth }) => {
    await seedAuth();
    await kv.put(kvKeys.authToken(LEGACY), USER_ID);

    const res = await readBooks(LEGACY);

    expect(res.status).toBe(401);
    expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
  });

  it("refuses a #425 token's hash presented as the bearer", async () => {
    const token = await seedAuthToken(kv, USER_ID);

    const res = await readBooks(await hashAuthToken(token));

    expect(res.status).toBe(401);
  });
});

describe("legacy token — migration on refresh", () => {
  it("returns the same token and rewrites both halves into the #425 shape", async () => {
    await seedLegacyAuthToken(kv, USER_ID, LEGACY, SECRET_AT);

    const res = await refresh(LEGACY);
    const now = Date.now();

    expect(res.status).toBe(200);
    const data = ((await res.json()) as Json).data;
    expect(data.token).toBe(LEGACY);
    expect(
      Math.abs(data.expiresAt - (now + TOKEN_TTL_SECONDS * 1000)),
    ).toBeLessThan(5000);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    const migrated = await hashedRecord(LEGACY);
    expect(migrated).toEqual({
      userId: USER_ID,
      createdAt: expect.any(String),
      expiresAt: data.expiresAt,
    });
    expect(await storedAuthRaw()).toStrictEqual({
      tokens: [
        { hash: await hashAuthToken(LEGACY), createdAt: migrated?.createdAt },
      ],
      secretAt: SECRET_AT,
    });
    // auth: is permanent (no TTL): it must outlive every token it lists.
    expect(getPutTtl(kv, kvKeys.auth(USER_ID))).toBeUndefined();
    expect(getPutTtl(kv, kvKeys.authToken(await hashAuthToken(LEGACY)))).toBe(
      TOKEN_TTL_SECONDS,
    );
  });

  it("keeps the migrated token working and refreshable through the hashed path", async () => {
    await seedLegacyAuthToken(kv, USER_ID, LEGACY);
    expect((await refresh(LEGACY)).status).toBe(200);
    const ops = watchKvOps(kv);

    expect((await readBooks(LEGACY)).status).toBe(200);
    const again = await refresh(LEGACY);

    expect(again.status).toBe(200);
    expect(((await again.json()) as Json).data.token).toBe(LEGACY);
    expect(ops.getKeys()).not.toContain(kvKeys.authToken(LEGACY));
  });

  it("refuses an orphan plaintext token the old record does not name", async () => {
    await seedLegacyAuthToken(kv, USER_ID, LEGACY);
    await kv.put(kvKeys.authToken(ORPHAN), USER_ID);
    const ops = watchKvOps(kv);

    const res = await refresh(ORPHAN);

    expect(res.status).toBe(401);
    expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
    expect(ops.writeTrail()).toEqual([]);
  });
});

describe("legacy token — migration on another device's mint", () => {
  it("lists the legacy token next to the new one without logging it out", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedLegacyAuthToken(kv, USER_ID, LEGACY, SECRET_AT);
    // A verify record as current as `secretAt`, so the stale-record check passes the join.
    await kv.put(
      kvKeys.verify(USER_ID),
      JSON.stringify({
        method: "none",
        hash: null,
        salt: null,
        prompted: 1,
        secretUpdatedAt: SECRET_AT,
      }),
    );

    const res = await request(
      "POST",
      `/api/family/${FAMILY_ID}/join`,
      undefined,
      { userId: USER_ID },
    );
    expect(res.status).toBe(200);
    const fresh = ((await res.json()) as Json).data.authToken as string;

    expect(fresh).not.toBe(LEGACY);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    expect((await hashedRecord(LEGACY))?.userId).toBe(USER_ID);
    expect((await readBooks(LEGACY)).status).toBe(200);
    expect((await readBooks(fresh)).status).toBe(200);
    const stored = await storedAuthRaw();
    expect((stored?.tokens as { hash: string }[]).map((e) => e.hash)).toEqual([
      await hashAuthToken(LEGACY),
      await hashAuthToken(fresh),
    ]);
    expect(stored?.secretAt).toBe(SECRET_AT);
    expect(stored).not.toHaveProperty("token");
    expect(stored).not.toHaveProperty("legacyToken");
  });
});

describe("legacy token — a revoked plaintext token is never revived", () => {
  it("drops a token a PIN save deleted when a stale auth: still names it", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedLegacyAuthToken(kv, USER_ID, LEGACY);
    const pinSave = await request(
      "PUT",
      `/api/user/${USER_ID}/verify`,
      LEGACY,
      {
        method: "pin",
        secret: PIN,
      },
    );
    expect(pinSave.status).toBe(200);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    // A colo that missed the PIN save's auth: write. See the header.
    await kv.put(
      kvKeys.auth(USER_ID),
      JSON.stringify({ token: LEGACY, createdAt: new Date().toISOString() }),
    );

    const res = await request(
      "POST",
      `/api/family/${FAMILY_ID}/join`,
      undefined,
      { userId: USER_ID, verifySecret: PIN },
    );

    expect(res.status).toBe(200);
    const fresh = ((await res.json()) as Json).data.authToken as string;
    expect(fresh).toMatch(/^[a-f0-9]{64}$/);
    expect(fresh).not.toBe(LEGACY);
    expect(await hashedRecord(LEGACY)).toBeNull();
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    expect(await storedAuthRaw()).toStrictEqual({
      tokens: [
        {
          hash: await hashAuthToken(fresh),
          createdAt: (await hashedRecord(fresh))?.createdAt,
        },
      ],
    });
    expect((await readBooks(LEGACY)).status).toBe(401);
    expect((await readBooks(fresh)).status).toBe(200);
  });
});

describe("legacy token — a plaintext key whose migration delete failed", () => {
  it("is inert once a revoke-all drops the hashed record", async () => {
    await seedLegacyAuthToken(kv, USER_ID, LEGACY);
    await mintAuthToken(kv, USER_ID, await readAuthRecord(kv, USER_ID));
    // The leftover of a failed plaintext delete. See the header.
    await kv.put(kvKeys.authToken(LEGACY), USER_ID);
    expect((await readBooks(LEGACY)).status).toBe(200);

    await readAndRevokeAllAuthTokens(kv, USER_ID);

    expect(await hashedRecord(LEGACY)).toBeNull();
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER_ID);
    const ops = watchKvOps(kv);
    const books = await readBooks(LEGACY);
    const renewed = await refresh(LEGACY);

    expect(books.status).toBe(401);
    expect(((await books.json()) as Json).error.code).toBe("UNAUTHORIZED");
    expect(renewed.status).toBe(401);
    expect(((await renewed.json()) as Json).error.code).toBe("UNAUTHORIZED");
    expect(ops.writeTrail()).toEqual([]);
    expect(await kv.get(kvKeys.auth(USER_ID))).toBeNull();
  });
});

describe("legacy token — revoke-all", () => {
  it("deletes the plaintext key when the legacy holder leaves", async () => {
    await seedFamily([OWNER_ID, USER_ID]);
    await seedLegacyAuthToken(kv, USER_ID, LEGACY);

    const res = await request(
      "DELETE",
      `/api/family/${FAMILY_ID}/member/${USER_ID}`,
      LEGACY,
    );

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER_ID))).toBeNull();
    expect((await readBooks(LEGACY)).status).toBe(401);
  });

  it("deletes the plaintext key on a PIN save and issues a hashed token", async () => {
    await seedLegacyAuthToken(kv, USER_ID, LEGACY);

    const res = await request("PUT", `/api/user/${USER_ID}/verify`, LEGACY, {
      method: "pin",
      secret: "123456",
    });

    expect(res.status).toBe(200);
    const issued = ((await res.json()) as Json).data.authToken as string;
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    expect((await readBooks(LEGACY)).status).toBe(401);
    expect((await hashedRecord(issued))?.userId).toBe(USER_ID);
  });
});
