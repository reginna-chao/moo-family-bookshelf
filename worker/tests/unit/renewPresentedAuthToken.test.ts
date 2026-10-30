import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { seedAuthToken, seedLegacyAuthToken } from "../helpers/auth";
import { USER1, USER2 } from "../helpers/ids";
import {
  mintAuthToken,
  readAndRevokeAllAuthTokens,
} from "../../src/services/authTokens";
import { renewPresentedAuthToken } from "../../src/services/authRenewal";
import {
  kvKeys,
  TOKEN_TTL_SECONDS,
  type AuthTokenRecord,
  type VerifyMethod,
} from "../../src/kv/schema";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * `renewPresentedAuthToken` (#425) is `POST /api/auth/refresh`'s token logic:
 * it renews ONLY the presented token. A listed token whose `token:{hash}` still
 * names the user slides to now + 90 days, capped 180 days after its
 * `createdAt` — except on a `code` account, whose `verify:` record is read
 * once, and only when the cap would bite. It writes that one `token:{hash}`
 * key and never `auth:{userId}`; a target within an hour of the stored
 * `expiresAt` writes nothing. `null` (→ 401 REFRESH_FAILED) when the bearer is
 * not current, its reverse key is gone or names someone else, its `createdAt`
 * is unreadable, or it is at the cap. A TTL gap (no record, empty list) mints.
 *
 * Seeds: token A is seeded 10 days old so the slide is observable (its stored
 * `expiresAt` is 80 days out); token B is minted by production so its recorded
 * TTL is real and can be shown untouched. The pre-#425 migration branch is
 * covered end-to-end in `integration/legacyTokenMigration.test.ts`.
 *
 * Pre-#425 legacy token, the unit-level halves (C3 / C4): the migration
 * migrates only while `token:{plaintext}` still names the user — a key deleted
 * since the middleware read it (a PIN save on another colo) answers `null` and
 * writes nothing. The writes run one at a time (C4, S1): `token:{hash}`, then
 * `auth:`, then the plaintext delete. Either put throwing (`failFirstWriteTo`)
 * leaves `auth:` in its legacy shape and the plaintext key alive, so the
 * device's retried refresh still migrates; and a revoke-all reading that legacy
 * record deletes both `token:{T}` and the already-written `token:{hash(T)}`.
 * The final plaintext delete is fail-open: when it throws the refresh still
 * returns T, logging `LEGACY_TOKEN_DELETE_FAILED` with `{ err }` only, and the
 * leftover key is inert (`readBooks` through the real middleware → 401 once the
 * hashed record is revoked).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TOKEN_A = "a".repeat(64);
const TOKEN_B_PLACEHOLDER = "b".repeat(64);
const LEGACY = "c".repeat(64);
const HEX_64 = /^[a-f0-9]{64}$/;

let kv: KVNamespace;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

async function seedVerifyMethod(method: VerifyMethod): Promise<void> {
  const configured = method === "pin" || method === "pattern";
  await kv.put(
    kvKeys.verify(USER1),
    JSON.stringify({
      method,
      hash: configured ? "f".repeat(64) : null,
      salt: configured ? "e".repeat(32) : null,
      prompted: 1,
    }),
  );
}

async function tokenRecord(token: string): Promise<AuthTokenRecord | null> {
  return kv.get<AuthTokenRecord>(
    kvKeys.authToken(await hashAuthToken(token)),
    "json",
  );
}

/** Mint B, then append A (`createdAt` = `ageDays` ago) to the same list. */
async function seedTwoDevices(ageDays: number): Promise<{ tokenB: string }> {
  const { token: tokenB } = await mintAuthToken(kv, USER1, null);
  await seedAuthToken(kv, USER1, {
    token: TOKEN_A,
    createdAt: daysAgo(ageDays),
    appendTo: true,
  });
  return { tokenB };
}

/** An authenticated owner-only read through the real middleware — the "does this bearer open anything" probe. */
async function readBooks(token: string): Promise<Response> {
  return app.request(
    `/api/user/${USER1}/books`,
    { headers: { Authorization: `Bearer ${token}` } },
    { KV: kv, DEV_MODE: "1" },
  );
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renewPresentedAuthToken — sliding renewal", () => {
  it("slides only the presented token's key to 90 days and never writes auth:", async () => {
    const { tokenB } = await seedTwoDevices(10);
    const hashA = await hashAuthToken(TOKEN_A);
    const hashB = await hashAuthToken(tokenB);
    const recordB = await tokenRecord(tokenB);
    const before = await tokenRecord(TOKEN_A);
    const ops = watchKvOps(kv);

    const issued = await renewPresentedAuthToken(kv, USER1, TOKEN_A);
    const now = Date.now();

    expect(issued?.token).toBe(TOKEN_A);
    expect(
      Math.abs(issued!.expiresAt - (now + TOKEN_TTL_SECONDS * 1000)),
    ).toBeLessThan(5000);
    expect(ops.putKeys()).toEqual([kvKeys.authToken(hashA)]);
    expect(ops.deleteKeys()).toEqual([]);
    expect(ops.putKeys()).not.toContain(kvKeys.auth(USER1));
    expect(getPutTtl(kv, kvKeys.authToken(hashA))).toBe(TOKEN_TTL_SECONDS);
    expect(getPutTtl(kv, kvKeys.authToken(hashB))).toBe(TOKEN_TTL_SECONDS);
    expect(await tokenRecord(TOKEN_A)).toEqual({
      userId: USER1,
      createdAt: before?.createdAt,
      expiresAt: issued!.expiresAt,
    });
    expect(await tokenRecord(tokenB)).toEqual(recordB);
  });

  it("reads verify: zero times while the cap does not bite", async () => {
    await seedTwoDevices(10);
    const ops = watchKvOps(kv);

    await renewPresentedAuthToken(kv, USER1, TOKEN_A);

    expect(ops.getKeys()).toEqual([
      kvKeys.auth(USER1),
      kvKeys.authToken(await hashAuthToken(TOKEN_A)),
    ]);
  });

  it("writes nothing on a second refresh within the hour and returns the same expiresAt", async () => {
    await seedTwoDevices(10);
    const first = await renewPresentedAuthToken(kv, USER1, TOKEN_A);
    const ops = watchKvOps(kv);

    const second = await renewPresentedAuthToken(kv, USER1, TOKEN_A);

    expect(second).toEqual(first);
    expect(ops.writeTrail()).toEqual([]);
  });
});

describe("renewPresentedAuthToken — the 180-day absolute cap", () => {
  it.each([
    {
      label: "100 days old",
      ageDays: 100,
      minMs: 79 * DAY_MS,
      maxMs: 80 * DAY_MS,
    },
    {
      label: "179 days old",
      ageDays: 179,
      minMs: 23 * HOUR_MS,
      maxMs: 24 * HOUR_MS,
    },
  ])(
    "renews a PIN account's $label token only up to createdAt + 180 days",
    async ({ ageDays, minMs, maxMs }) => {
      await seedVerifyMethod("pin");
      await seedTwoDevices(ageDays);
      const hashA = await hashAuthToken(TOKEN_A);
      const ops = watchKvOps(kv);

      const issued = await renewPresentedAuthToken(kv, USER1, TOKEN_A);
      const left = issued!.expiresAt - Date.now();

      expect(issued?.token).toBe(TOKEN_A);
      expect(left).toBeGreaterThan(minMs);
      expect(left).toBeLessThanOrEqual(maxMs);
      const ttl = getPutTtl(kv, kvKeys.authToken(hashA))!;
      expect(ttl * 1000).toBeGreaterThan(minMs);
      expect(ttl * 1000).toBeLessThanOrEqual(maxMs);
      expect((await tokenRecord(TOKEN_A))?.expiresAt).toBe(issued!.expiresAt);
      expect(
        ops.getKeys().filter((k) => k === kvKeys.verify(USER1)),
      ).toHaveLength(1);
      expect(ops.putKeys()).toEqual([kvKeys.authToken(hashA)]);
    },
  );

  it.each(["pin", "pattern", "none"] as const)(
    "refuses a %s account's token at 180 days and writes nothing",
    async (method) => {
      await seedVerifyMethod(method);
      await seedTwoDevices(180);
      const ops = watchKvOps(kv);

      expect(await renewPresentedAuthToken(kv, USER1, TOKEN_A)).toBeNull();

      expect(ops.writeTrail()).toEqual([]);
    },
  );

  it("refuses a token with no verify: record at 180 days (the none default)", async () => {
    await seedTwoDevices(180);

    expect(await renewPresentedAuthToken(kv, USER1, TOKEN_A)).toBeNull();
  });

  it("renews a code account's 179-day token for the full 90 days, reading verify: once", async () => {
    await seedVerifyMethod("code");
    await seedTwoDevices(179);
    const hashA = await hashAuthToken(TOKEN_A);
    const ops = watchKvOps(kv);

    const issued = await renewPresentedAuthToken(kv, USER1, TOKEN_A);
    const now = Date.now();

    expect(issued?.token).toBe(TOKEN_A);
    expect(
      Math.abs(issued!.expiresAt - (now + TOKEN_TTL_SECONDS * 1000)),
    ).toBeLessThan(5000);
    expect(getPutTtl(kv, kvKeys.authToken(hashA))).toBe(TOKEN_TTL_SECONDS);
    expect(
      ops.getKeys().filter((k) => k === kvKeys.verify(USER1)),
    ).toHaveLength(1);
  });

  it("renews a code account's token even past 180 days", async () => {
    await seedVerifyMethod("code");
    await seedTwoDevices(200);

    const issued = await renewPresentedAuthToken(kv, USER1, TOKEN_A);

    expect(issued?.token).toBe(TOKEN_A);
  });
});

describe("renewPresentedAuthToken — refusals", () => {
  it("refuses a token that still has its key but is off the list, writing nothing", async () => {
    // TOKEN_B keeps a live reverse key, then the list is replaced by TOKEN_A's alone.
    await seedAuthToken(kv, USER1, { token: TOKEN_B_PLACEHOLDER });
    await seedAuthToken(kv, USER1, { token: TOKEN_A });
    const ops = watchKvOps(kv);

    expect(
      await renewPresentedAuthToken(kv, USER1, TOKEN_B_PLACEHOLDER),
    ).toBeNull();

    expect(ops.writeTrail()).toEqual([]);
  });

  it.each([
    {
      label: "its token: key is gone",
      tamper: async (hash: string) => kv.delete(kvKeys.authToken(hash)),
    },
    {
      label: "its token: key names another user",
      tamper: async (hash: string) =>
        kv.put(
          kvKeys.authToken(hash),
          JSON.stringify({
            userId: USER2,
            createdAt: daysAgo(1),
            expiresAt: 0,
          }),
        ),
    },
  ])("refuses a listed token when $label", async ({ tamper }) => {
    await seedAuthToken(kv, USER1, { token: TOKEN_A, createdAt: daysAgo(10) });
    await tamper(await hashAuthToken(TOKEN_A));
    const ops = watchKvOps(kv);

    expect(await renewPresentedAuthToken(kv, USER1, TOKEN_A)).toBeNull();

    expect(ops.writeTrail()).toEqual([]);
  });

  it("refuses a listed token whose createdAt is unreadable", async () => {
    const hash = await hashAuthToken(TOKEN_A);
    await kv.put(
      kvKeys.auth(USER1),
      JSON.stringify({ tokens: [{ hash, createdAt: "not-a-date" }] }),
    );
    await kv.put(
      kvKeys.authToken(hash),
      JSON.stringify({ userId: USER1, createdAt: "not-a-date", expiresAt: 0 }),
    );

    expect(await renewPresentedAuthToken(kv, USER1, TOKEN_A)).toBeNull();
  });
});

describe("renewPresentedAuthToken — TTL gap", () => {
  it.each([
    { label: "there is no auth: record", seed: async () => {} },
    {
      label: "the auth: list is empty",
      seed: () => kv.put(kvKeys.auth(USER1), JSON.stringify({ tokens: [] })),
    },
  ])("mints a new listed token when $label", async ({ seed }) => {
    await seed();

    const issued = await renewPresentedAuthToken(kv, USER1, TOKEN_A);

    expect(issued?.token).toMatch(/^[a-f0-9]{64}$/);
    expect(issued?.token).not.toBe(TOKEN_A);
    expect((await tokenRecord(issued!.token))?.userId).toBe(USER1);
    const auth = await kv.get<{ tokens: { hash: string }[] }>(
      kvKeys.auth(USER1),
      "json",
    );
    expect(auth?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(issued!.token),
    ]);
  });
});

describe("renewPresentedAuthToken — pre-#425 legacy token", () => {
  async function storedAuthRaw(): Promise<Record<string, unknown> | null> {
    return kv.get<Record<string, unknown>>(kvKeys.auth(USER1), "json");
  }

  it.each([
    { label: "is gone", plaintext: null },
    { label: "names another user", plaintext: USER2 },
  ])(
    "refuses and writes nothing when the plaintext key $label",
    async ({ plaintext }) => {
      await seedLegacyAuthToken(kv, USER1, LEGACY);
      await kv.delete(kvKeys.authToken(LEGACY));
      if (plaintext !== null) {
        await kv.put(kvKeys.authToken(LEGACY), plaintext);
      }
      const before = await storedAuthRaw();
      const ops = watchKvOps(kv);

      expect(await renewPresentedAuthToken(kv, USER1, LEGACY)).toBeNull();

      expect(ops.writeTrail()).toEqual([]);
      expect(await storedAuthRaw()).toEqual(before);
      expect(await tokenRecord(LEGACY)).toBeNull();
    },
  );

  it("puts token:{hash}, then auth:, and deletes the plaintext key last", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY);
    const ops = watchKvOps(kv);

    expect((await renewPresentedAuthToken(kv, USER1, LEGACY))?.token).toBe(
      LEGACY,
    );

    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.authToken(await hashAuthToken(LEGACY))}`,
      `put ${kvKeys.auth(USER1)}`,
      `delete ${kvKeys.authToken(LEGACY)}`,
    ]);
  });

  it.each([
    { label: "token:{hash}", failing: "hash", hashWritten: false },
    { label: "auth:", failing: "auth", hashWritten: true },
  ])(
    "keeps auth: and the plaintext key when the $label put throws, and a retry migrates",
    async ({ failing, hashWritten }) => {
      await seedLegacyAuthToken(kv, USER1, LEGACY);
      const legacyRecord = await storedAuthRaw();
      const hashKey = kvKeys.authToken(await hashAuthToken(LEGACY));
      failFirstWriteTo(
        kv,
        "put",
        failing === "hash" ? hashKey : kvKeys.auth(USER1),
      );

      await expect(renewPresentedAuthToken(kv, USER1, LEGACY)).rejects.toThrow(
        "KV down",
      );

      expect(await storedAuthRaw()).toEqual(legacyRecord);
      expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER1);
      expect((await tokenRecord(LEGACY))?.userId ?? null).toBe(
        hashWritten ? USER1 : null,
      );

      const retried = await renewPresentedAuthToken(kv, USER1, LEGACY);

      expect(retried?.token).toBe(LEGACY);
      expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
      const migrated = await tokenRecord(LEGACY);
      expect(migrated).toEqual({
        userId: USER1,
        createdAt: expect.any(String),
        expiresAt: retried!.expiresAt,
      });
      expect(await storedAuthRaw()).toStrictEqual({
        tokens: [
          { hash: await hashAuthToken(LEGACY), createdAt: migrated?.createdAt },
        ],
      });
    },
  );

  it("revoke-all deletes the hashed record a half-done migration left behind", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY);
    failFirstWriteTo(kv, "put", kvKeys.auth(USER1));
    await expect(renewPresentedAuthToken(kv, USER1, LEGACY)).rejects.toThrow(
      "KV down",
    );
    expect((await tokenRecord(LEGACY))?.userId).toBe(USER1);

    await readAndRevokeAllAuthTokens(kv, USER1);

    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    expect(await tokenRecord(LEGACY)).toBeNull();
    expect(await storedAuthRaw()).toBeNull();
  });

  it("still returns the token when the plaintext delete throws, logging no identifier", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failFirstWriteTo(kv, "delete", kvKeys.authToken(LEGACY));

    const issued = await renewPresentedAuthToken(kv, USER1, LEGACY);

    expect(issued?.token).toMatch(HEX_64);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("LEGACY_TOKEN_DELETE_FAILED");
    expect(Object.keys(errors.mock.calls[0][1] as object)).toEqual(["err"]);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER1);
    expect((await tokenRecord(LEGACY))?.userId).toBe(USER1);
    expect(
      ((await storedAuthRaw())?.tokens as { hash: string }[]).map(
        (e) => e.hash,
      ),
    ).toEqual([await hashAuthToken(LEGACY)]);
    // The leftover key alone opens nothing once the hashed record is revoked.
    await readAndRevokeAllAuthTokens(kv, USER1);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER1);
    const res = await readBooks(LEGACY);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "UNAUTHORIZED",
    );
    expect(issued?.token).toBe(LEGACY);
  });
});
