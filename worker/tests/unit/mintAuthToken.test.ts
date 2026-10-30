import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { failFirstWriteTo, watchKvOps } from "../helpers/kvOps";
import { seedAuthToken, seedLegacyAuthToken } from "../helpers/auth";
import { USER1, USER2 } from "../helpers/ids";
import {
  mintAuthToken,
  readAndRevokeAllAuthTokens,
  readAuthRecord,
  renewPresentedAuthToken,
} from "../../src/middleware/auth";
import {
  kvKeys,
  MAX_AUTH_TOKENS_PER_USER,
  TOKEN_MAX_AGE_SECONDS,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
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
 * `createdAt`, deleting the evicted `token:` keys. A pre-#425 `legacyToken` in
 * `knownAuth` is migrated into the list (its plaintext key deleted, its hash
 * key written) — never evicted by that same mint, never logged out.
 * `secretAt` replaces the carried-forward value; with neither, it is absent.
 *
 * Live legacy only (C3): the migration first reads `token:{plaintext}` and
 * migrates only while it names this user. A dead one — deleted by a PIN save a
 * stale `auth:` read has not seen, or naming someone else — is dropped: no
 * `token:{hash}`, no list entry, nothing deleted. Order (C4, S1): evicted keys
 * are deleted first, then — one write at a time — the migrated `token:{hash}`,
 * then `auth:` (with the new token's key), and the plaintext key LAST. A
 * migrated-key put that throws (`failFirstWriteTo`) leaves `auth:` in its legacy
 * shape and the plaintext key alive, so a retry that re-reads `auth:` still
 * migrates it. The final plaintext delete is fail-open: when it throws the mint
 * still returns, logging `LEGACY_TOKEN_DELETE_FAILED` with `{ err }` only, and
 * the leftover key is inert (`readBooks` through the real middleware → 401 once
 * the hashed record is revoked).
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
const LEGACY = "c".repeat(64);

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
    expect(ops.deleteKeys()).toEqual([expected[0]]);
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

describe("mintAuthToken — pre-#425 legacy token", () => {
  it("migrates the legacy token into the list instead of logging it out", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY, SECRET_AT);
    const known = await readAuthRecord(kv, USER1);

    const issued = await mintAuthToken(kv, USER1, known);

    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    const migrated = await tokenRecord(LEGACY);
    expect(migrated?.userId).toBe(USER1);
    expect(getPutTtl(kv, kvKeys.authToken(await hashAuthToken(LEGACY)))).toBe(
      TOKEN_TTL_SECONDS,
    );
    const stored = await storedAuth();
    expect(stored?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(LEGACY),
      await hashAuthToken(issued.token),
    ]);
    expect(stored?.secretAt).toBe(SECRET_AT);
    expect(stored).not.toHaveProperty("token");
    expect(stored).not.toHaveProperty("legacyToken");
  });

  it("never evicts the just-migrated legacy entry, even on a full list", async () => {
    const tokens = await seedDevices(MAX_AUTH_TOKENS_PER_USER);
    const listed = await readAuthRecord(kv, USER1);
    await kv.put(kvKeys.authToken(LEGACY), USER1);
    const known: AuthRecord = { ...listed!, legacyToken: LEGACY };

    const issued = await mintAuthToken(kv, USER1, known);

    const hashes = (await storedAuth())!.tokens.map((e) => e.hash);
    expect(hashes).toHaveLength(MAX_AUTH_TOKENS_PER_USER);
    expect(hashes).toContain(await hashAuthToken(LEGACY));
    expect(hashes).toContain(await hashAuthToken(issued.token));
    expect((await tokenRecord(LEGACY))?.userId).toBe(USER1);
    // The two oldest live tokens make the room.
    expect(await tokenRecord(tokens[0])).toBeNull();
    expect(await tokenRecord(tokens[1])).toBeNull();
    expect((await tokenRecord(tokens[2]))?.userId).toBe(USER1);
  });

  it.each([
    { label: "its plaintext key is gone", plaintext: null },
    { label: "its plaintext key names another user", plaintext: USER2 },
  ])(
    "drops a dead legacy token ($label) instead of reviving it",
    async ({ plaintext }) => {
      if (plaintext !== null) {
        await kv.put(kvKeys.authToken(LEGACY), plaintext);
      }
      const ops = watchKvOps(kv);

      const issued = await mintAuthToken(kv, USER1, {
        tokens: [],
        legacyToken: LEGACY,
      });

      const gets = ops.getKeys();
      const trail = ops.writeTrail();
      const hash = await hashAuthToken(issued.token);
      expect(gets).toEqual([kvKeys.authToken(LEGACY)]);
      expect(trail).toEqual([
        `put ${kvKeys.auth(USER1)}`,
        `put ${kvKeys.authToken(hash)}`,
      ]);
      expect(await storedAuth()).toEqual({
        tokens: [
          { hash, createdAt: (await tokenRecord(issued.token))?.createdAt },
        ],
      });
      expect(await tokenRecord(LEGACY)).toBeNull();
      expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(plaintext);
    },
  );

  it("puts token:{hash}, then auth:, and deletes the plaintext key last", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY);
    const known = await readAuthRecord(kv, USER1);
    const ops = watchKvOps(kv);

    const issued = await mintAuthToken(kv, USER1, known);

    expect(ops.writeTrail()).toEqual([
      `put ${kvKeys.authToken(await hashAuthToken(LEGACY))}`,
      `put ${kvKeys.auth(USER1)}`,
      `put ${kvKeys.authToken(await hashAuthToken(issued.token))}`,
      `delete ${kvKeys.authToken(LEGACY)}`,
    ]);
  });

  it("deletes evicted keys before the puts and the migrated plaintext key after them", async () => {
    const tokens = await seedDevices(MAX_AUTH_TOKENS_PER_USER);
    const listed = await readAuthRecord(kv, USER1);
    await kv.put(kvKeys.authToken(LEGACY), USER1);
    const known: AuthRecord = { ...listed!, legacyToken: LEGACY };
    const ops = watchKvOps(kv);

    const issued = await mintAuthToken(kv, USER1, known);

    expect(ops.writeTrail()).toEqual([
      `delete ${kvKeys.authToken(await hashAuthToken(tokens[0]))}`,
      `delete ${kvKeys.authToken(await hashAuthToken(tokens[1]))}`,
      `put ${kvKeys.authToken(await hashAuthToken(LEGACY))}`,
      `put ${kvKeys.auth(USER1)}`,
      `put ${kvKeys.authToken(await hashAuthToken(issued.token))}`,
      `delete ${kvKeys.authToken(LEGACY)}`,
    ]);
  });

  it("keeps auth: and the plaintext key when the migrated token:{hash} put throws, and a retry migrates it", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY);
    const legacyRecord = await storedAuth();
    failFirstWriteTo(kv, "put", kvKeys.authToken(await hashAuthToken(LEGACY)));

    await expect(
      mintAuthToken(kv, USER1, await readAuthRecord(kv, USER1)),
    ).rejects.toThrow("KV down");

    expect(await storedAuth()).toEqual(legacyRecord);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER1);
    expect(await tokenRecord(LEGACY)).toBeNull();

    const retried = await mintAuthToken(
      kv,
      USER1,
      await readAuthRecord(kv, USER1),
    );

    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    expect((await tokenRecord(LEGACY))?.userId).toBe(USER1);
    expect((await storedAuth())?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(LEGACY),
      await hashAuthToken(retried.token),
    ]);
  });

  it("keeps auth: and the plaintext key when the auth: put throws, and a retry migrates it", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY);
    const legacyRecord = await storedAuth();
    failFirstWriteTo(kv, "put", kvKeys.auth(USER1));

    await expect(
      mintAuthToken(kv, USER1, await readAuthRecord(kv, USER1)),
    ).rejects.toThrow("KV down");

    expect(await storedAuth()).toEqual(legacyRecord);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER1);

    const retried = await mintAuthToken(
      kv,
      USER1,
      await readAuthRecord(kv, USER1),
    );

    expect(await kv.get(kvKeys.authToken(LEGACY))).toBeNull();
    expect((await storedAuth())?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(LEGACY),
      await hashAuthToken(retried.token),
    ]);
  });

  it("still returns the token when the plaintext delete throws, logging no identifier", async () => {
    await seedLegacyAuthToken(kv, USER1, LEGACY);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failFirstWriteTo(kv, "delete", kvKeys.authToken(LEGACY));

    const issued = await mintAuthToken(
      kv,
      USER1,
      await readAuthRecord(kv, USER1),
    );

    expect(issued.token).toMatch(HEX_64);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe("LEGACY_TOKEN_DELETE_FAILED");
    expect(Object.keys(errors.mock.calls[0][1] as object)).toEqual(["err"]);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER1);
    expect((await tokenRecord(LEGACY))?.userId).toBe(USER1);
    expect((await storedAuth())?.tokens.map((e) => e.hash)).toEqual([
      await hashAuthToken(LEGACY),
      await hashAuthToken(issued.token),
    ]);
    // The leftover key alone opens nothing once the hashed record is revoked.
    await readAndRevokeAllAuthTokens(kv, USER1);
    expect(await kv.get(kvKeys.authToken(LEGACY))).toBe(USER1);
    const res = await readBooks(LEGACY);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "UNAUTHORIZED",
    );
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
