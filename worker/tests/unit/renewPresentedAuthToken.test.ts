import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import { USER1, USER2 } from "../helpers/ids";
import {
  mintAuthToken,
  renewPresentedAuthToken,
} from "../../src/middleware/auth";
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
 * TTL is real and can be shown untouched.
 *
 * A pre-#425 `{ token, createdAt, secretAt? }` record reads as an empty list
 * (#432), so it takes the TTL-gap branch: a new token is minted into a fresh
 * list, `secretAt` is kept, and no `token:` key of the presented bearer is
 * read or deleted.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TOKEN_A = "a".repeat(64);
const TOKEN_B_PLACEHOLDER = "b".repeat(64);

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

describe("renewPresentedAuthToken — pre-#425 record (#432)", () => {
  it("mints a new listed token over an old-shape auth: record, keeping secretAt and never touching token:{T}", async () => {
    const T = await seedAuthToken(kv, USER1);
    await kv.put(
      kvKeys.auth(USER1),
      JSON.stringify({
        token: T,
        createdAt: new Date().toISOString(),
        secretAt: 9,
      }),
    );
    const ops = watchKvOps(kv);

    const issued = await renewPresentedAuthToken(kv, USER1, T);

    expect(issued?.token).toMatch(/^[a-f0-9]{64}$/);
    expect(issued?.token).not.toBe(T);
    const auth = await kv.get<{
      tokens: { hash: string }[];
      secretAt?: number;
    }>(kvKeys.auth(USER1), "json");
    expect(auth?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(issued!.token),
    ]);
    expect(auth?.secretAt).toBe(9);
    // Positive companions: the auth: read and put are observed, so the negatives below cannot pass vacuously.
    expect(ops.getKeys()).toContain(kvKeys.auth(USER1));
    expect(ops.writeTrail()).toContain(`put ${kvKeys.auth(USER1)}`);
    expect(ops.getKeys()).not.toContain(kvKeys.authToken(T));
    expect(ops.writeTrail()).not.toContain(`delete ${kvKeys.authToken(T)}`);
  });
});
