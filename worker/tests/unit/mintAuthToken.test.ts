import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import { USER1, USER2 } from "../helpers/ids";
import { readAuthRecord } from "../../src/services/authRecord";
import {
  mintAuthToken,
  readAndRevokeAllAuthTokens,
} from "../../src/services/authTokens";
import { renewPresentedAuthToken } from "../../src/services/authRenewal";
import {
  kvKeys,
  MAX_AUTH_TOKENS_PER_USER,
  TOKEN_MAX_AGE_SECONDS,
  TOKEN_TTL_SECONDS,
  type AuthTokenRecord,
  type StoredAuthRecord,
} from "../../src/kv/schema";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * `mintAuthToken` (#425) issues a NEW token for one device: the plaintext is
 * returned and never stored; `token:{hash}` gets `{ userId, createdAt,
 * expiresAt }` with the 90-day TTL, and `auth:{userId}` is put exactly once,
 * with NO TTL, with the hash appended to the account's list. At most
 * `MAX_AUTH_TOKENS_PER_USER` (5) tokens are listed: a sixth mint evicts dead
 * entries (reverse key gone, or naming someone else) first, then the oldest
 * `createdAt`, deleting the evicted `token:` keys, then their `tokenidx:` keys
 * (#431). Evicted keys are deleted before the new token's `tokenidx:` put, which
 * precedes `auth:` and its `token:{hash}` put. `secretAt` replaces the carried-forward value; with
 * neither, it is absent. A pre-#425 `{ token, createdAt, secretAt? }` record
 * reads as `{ tokens: [], secretAt? }` (#432): the mint treats it as an empty
 * list, reads no `token:` key and keeps `secretAt`.
 *
 * Why `auth:` is permanent (reviewer C1): a `code` account's tokens are exempt
 * from the 180-day cap and keep sliding, so any fixed `auth:` TTL could lapse
 * while a token it lists is still alive — and a revoke-all reads that list to
 * find the keys to delete. The mock never expires keys, so the regression case
 * proves it through `getPutTtl` (no TTL on the only `auth:` write) plus a
 * revoke-all after the old cap that still deletes every listed key. `Date` is
 * faked there only; timers stay real.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET_AT = 1_767_225_600_000;
const HEX_64 = /^[a-f0-9]{64}$/;

let kv: KVNamespace;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** Distinct 64-hex token per index. */
function deviceToken(i: number): string {
  return i.toString(16).padStart(2, "0").repeat(32);
}

async function storedAuth(): Promise<StoredAuthRecord | null> {
  return kv.get<StoredAuthRecord>(kvKeys.auth(USER1), "json");
}

async function tokenRecord(token: string): Promise<AuthTokenRecord | null> {
  return kv.get<AuthTokenRecord>(
    kvKeys.authToken(await hashAuthToken(token)),
    "json",
  );
}

/** Seed `count` devices, device 0 the oldest (`count` days ago), each a day newer. */
async function seedDevices(count: number): Promise<string[]> {
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    tokens.push(
      await seedAuthToken(kv, USER1, {
        token: deviceToken(i + 1),
        createdAt: daysAgo(count - i),
        appendTo: i > 0,
      }),
    );
  }
  return tokens;
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintAuthToken — storage shape", () => {
  it("stores only the token's hash, with the 90-day record and the 180-day list", async () => {
    const issued = await mintAuthToken(kv, USER1, null);
    const hash = await hashAuthToken(issued.token);
    const now = Date.now();

    expect(issued.token).toMatch(HEX_64);
    expect(await kv.get(kvKeys.authToken(issued.token))).toBeNull();
    const record = await tokenRecord(issued.token);
    expect(record?.userId).toBe(USER1);
    expect(
      Math.abs(record!.expiresAt - (now + TOKEN_TTL_SECONDS * 1000)),
    ).toBeLessThan(5000);
    expect(issued.expiresAt).toBe(record?.expiresAt);
    expect(await storedAuth()).toEqual({
      tokens: [{ hash, createdAt: record?.createdAt }],
    });
    // A written-but-TTL-less key: the `get` above proves the write, this proves no TTL.
    expect(getPutTtl(kv, kvKeys.auth(USER1))).toBeUndefined();
    expect(getPutTtl(kv, kvKeys.authToken(hash))).toBe(TOKEN_TTL_SECONDS);
  });

  it("puts auth: exactly once and deletes nothing when the list has room", async () => {
    const known = await readAuthRecord(kv, USER1);
    const ops = watchKvOps(kv);

    await mintAuthToken(kv, USER1, known);

    expect(ops.putKeys().filter((k) => k === kvKeys.auth(USER1))).toHaveLength(
      1,
    );
    expect(ops.deleteKeys()).toEqual([]);
    expect(ops.getKeys()).toEqual([]);
  });

  it("mints a different token each time, and both stay valid and listed", async () => {
    const first = await mintAuthToken(kv, USER1, null);
    const second = await mintAuthToken(
      kv,
      USER1,
      await readAuthRecord(kv, USER1),
    );

    expect(second.token).not.toBe(first.token);
    expect((await tokenRecord(first.token))?.userId).toBe(USER1);
    expect((await tokenRecord(second.token))?.userId).toBe(USER1);
    expect((await storedAuth())?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(first.token),
      await hashAuthToken(second.token),
    ]);
  });
});

describe("mintAuthToken — eviction past MAX_AUTH_TOKENS_PER_USER", () => {
  it("evicts the oldest of five live tokens on the sixth mint", async () => {
    const tokens = await seedDevices(MAX_AUTH_TOKENS_PER_USER);
    const known = await readAuthRecord(kv, USER1);

    const issued = await mintAuthToken(kv, USER1, known);

    expect(await tokenRecord(tokens[0])).toBeNull();
    const listed = (await storedAuth())!.tokens.map((e) => e.hash);
    expect(listed).toHaveLength(MAX_AUTH_TOKENS_PER_USER);
    for (const token of [...tokens.slice(1), issued.token]) {
      expect((await tokenRecord(token))?.userId).toBe(USER1);
      expect(listed).toContain(await hashAuthToken(token));
    }
    expect(listed).not.toContain(await hashAuthToken(tokens[0]));
  });

  it.each([
    {
      label: "its token: key is gone",
      kill: (hash: string) => kv.delete(kvKeys.authToken(hash)),
    },
    {
      label: "its token: key names another user",
      kill: (hash: string) =>
        kv.put(
          kvKeys.authToken(hash),
          JSON.stringify({
            userId: USER2,
            createdAt: daysAgo(0),
            expiresAt: 0,
          }),
        ),
    },
  ])(
    "evicts a newer dead entry ($label) before the oldest live token",
    async ({ kill }) => {
      const tokens = await seedDevices(MAX_AUTH_TOKENS_PER_USER);
      const dead = tokens[MAX_AUTH_TOKENS_PER_USER - 1]; // the newest createdAt
      await kill(await hashAuthToken(dead));
      const known = await readAuthRecord(kv, USER1);

      const issued = await mintAuthToken(kv, USER1, known);

      const listed = (await storedAuth())!.tokens.map((e) => e.hash);
      expect(listed).toHaveLength(MAX_AUTH_TOKENS_PER_USER);
      expect(listed).not.toContain(await hashAuthToken(dead));
      for (const token of [...tokens.slice(0, -1), issued.token]) {
        expect((await tokenRecord(token))?.userId).toBe(USER1);
      }
    },
  );

  it("reads each listed token: key once, only when the list is full", async () => {
    const tokens = await seedDevices(MAX_AUTH_TOKENS_PER_USER);
    const known = await readAuthRecord(kv, USER1);
    const ops = watchKvOps(kv);

    await mintAuthToken(kv, USER1, known);

    const expected = await Promise.all(
      tokens.map(async (t) => kvKeys.authToken(await hashAuthToken(t))),
    );
    expect([...ops.getKeys()].sort()).toEqual([...expected].sort());
    expect(ops.deleteKeys()).toEqual([
      expected[0],
      kvKeys.authTokenIndex(USER1, await hashAuthToken(tokens[0])),
    ]);
  });

  it("deletes the evicted key before it puts auth:", async () => {
    const tokens = await seedDevices(MAX_AUTH_TOKENS_PER_USER);
    const known = await readAuthRecord(kv, USER1);
    const ops = watchKvOps(kv);

    await mintAuthToken(kv, USER1, known);

    const trail = ops.writeTrail();
    const evicted = `delete ${kvKeys.authToken(await hashAuthToken(tokens[0]))}`;
    expect(trail.indexOf(evicted)).toBeLessThan(
      trail.indexOf(`put ${kvKeys.auth(USER1)}`),
    );
  });

  it("fails the mint and writes nothing when an evicted key's delete throws", async () => {
    await seedDevices(MAX_AUTH_TOKENS_PER_USER);
    const known = await readAuthRecord(kv, USER1);
    const before = await storedAuth();
    vi.spyOn(kv, "delete").mockRejectedValue(new Error("KV down"));
    const puts = vi.spyOn(kv, "put");

    await expect(mintAuthToken(kv, USER1, known)).rejects.toThrow("KV down");

    expect(puts).not.toHaveBeenCalled();
    expect(await storedAuth()).toEqual(before);
  });
});

describe("mintAuthToken — pre-#425 record (#432)", () => {
  it("mints into the empty list an old-shape record reads as, reading no token: key and keeping secretAt", async () => {
    const ops = watchKvOps(kv);

    const issued = await mintAuthToken(kv, USER1, { tokens: [], secretAt: 9 });

    const hash = await hashAuthToken(issued.token);
    // No read at all — in particular no `token:` lookup of a plaintext bearer.
    expect(ops.getKeys()).toEqual([]);
    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.authTokenIndex(USER1, hash)}`,
      `put ${kvKeys.auth(USER1)}`,
      `put ${kvKeys.authToken(hash)}`,
    ]);
    const stored = await storedAuth();
    expect(stored?.tokens.map((e) => e.hash)).toEqual([hash]);
    expect(stored?.secretAt).toBe(9);
  });
});

describe("mintAuthToken — auth: outlives a code account's tokens", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes auth: without a TTL, so a revoke-all past 180 days still finds every key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const day0 = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(day0);
    await kv.put(
      kvKeys.verify(USER1),
      JSON.stringify({ method: "code", hash: null, salt: null, prompted: 1 }),
    );
    const a = await mintAuthToken(kv, USER1, null);
    const b = await mintAuthToken(kv, USER1, await readAuthRecord(kv, USER1));
    expect(await kv.get(kvKeys.auth(USER1))).not.toBeNull();
    expect(getPutTtl(kv, kvKeys.auth(USER1))).toBeUndefined();

    vi.setSystemTime(day0 + 170 * DAY_MS);
    const renewed = await renewPresentedAuthToken(kv, USER1, a.token);
    expect(renewed?.token).toBe(a.token);
    expect(renewed!.expiresAt).toBe(day0 + 260 * DAY_MS);
    expect(renewed!.expiresAt).toBeGreaterThan(
      day0 + TOKEN_MAX_AGE_SECONDS * 1000,
    );
    // The refresh never rewrote auth:, so the mint's TTL-less write still stands.
    expect(getPutTtl(kv, kvKeys.auth(USER1))).toBeUndefined();

    vi.setSystemTime(day0 + 182 * DAY_MS);
    await readAndRevokeAllAuthTokens(kv, USER1);

    expect(await tokenRecord(a.token)).toBeNull();
    expect(await tokenRecord(b.token)).toBeNull();
    expect(await kv.get(kvKeys.auth(USER1))).toBeNull();
  });
});

describe("mintAuthToken — secretAt", () => {
  it("writes an explicit secretAt over the carried-forward one", async () => {
    await mintAuthToken(kv, USER1, { tokens: [], secretAt: 1 }, SECRET_AT);

    expect((await storedAuth())?.secretAt).toBe(SECRET_AT);
  });

  it("carries knownAuth's secretAt forward when none is given", async () => {
    await mintAuthToken(kv, USER1, { tokens: [], secretAt: SECRET_AT });

    expect((await storedAuth())?.secretAt).toBe(SECRET_AT);
  });

  it.each([
    { label: "no record was known", known: null },
    { label: "the known record has none", known: { tokens: [] } },
  ])("omits secretAt when $label", async ({ known }) => {
    await mintAuthToken(kv, USER1, known);

    expect(await storedAuth()).not.toHaveProperty("secretAt");
  });
});
