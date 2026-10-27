import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { USER1, USER2 } from "../helpers/ids";
import { generateAuthToken, renewAuthToken } from "../../src/middleware/auth";
import {
  kvKeys,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
} from "../../src/kv/schema";

/**
 * `renewAuthToken` (#378) is the renew-only half of token issue: when the
 * given `auth:{userId}` record's token still has its reverse `token:{token}`
 * entry mapping to that user, both entries are re-put with the 90-day TTL —
 * token, `createdAt` and `secretAt` unchanged — and the token is returned.
 * Otherwise (no record, no token, reverse key missing or naming another user)
 * it returns `null` and writes nothing. It costs at most one KV read and never
 * mints: the QR-bypass join relies on that.
 *
 * `generateAuthToken`'s `secretAt` parameter is written onto the new record;
 * when omitted, the replaced record's `secretAt` is carried forward; with
 * neither, the field is absent.
 */

const TOKEN = "a".repeat(64);
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const SECRET_AT = 1_767_225_600_000;
const HEX_64 = /^[a-f0-9]{64}$/;

let kv: KVNamespace;

function record(secretAt?: number): AuthRecord {
  return {
    token: TOKEN,
    createdAt: CREATED_AT,
    ...(secretAt !== undefined && { secretAt }),
  };
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renewAuthToken", () => {
  it.each([
    { label: "with secretAt", auth: record(SECRET_AT) },
    { label: "without secretAt", auth: record() },
  ])(
    "re-puts both entries of a live token with the token TTL, $label",
    async ({ auth }) => {
      await kv.put(kvKeys.authToken(TOKEN), USER1);
      const ops = watchKvOps(kv);

      const renewed = await renewAuthToken(kv, USER1, auth);

      expect(renewed).toBe(TOKEN);
      expect([...ops.putKeys()].sort()).toEqual(
        [kvKeys.auth(USER1), kvKeys.authToken(TOKEN)].sort(),
      );
      expect(ops.deleteKeys()).toEqual([]);
      expect(ops.getKeys()).toEqual([kvKeys.authToken(TOKEN)]);
      expect(await kv.get(kvKeys.auth(USER1), "json")).toEqual(auth);
      expect(await kv.get(kvKeys.authToken(TOKEN))).toBe(USER1);
      expect(getPutTtl(kv, kvKeys.auth(USER1))).toBe(TOKEN_TTL_SECONDS);
      expect(getPutTtl(kv, kvKeys.authToken(TOKEN))).toBe(TOKEN_TTL_SECONDS);
    },
  );

  it.each([
    {
      label: "the reverse entry is missing",
      seed: async () => {},
      auth: record(SECRET_AT),
    },
    {
      label: "the reverse entry maps to another user",
      seed: () => kv.put(kvKeys.authToken(TOKEN), USER2),
      auth: record(SECRET_AT),
    },
  ])("returns null and writes nothing when $label", async ({ seed, auth }) => {
    await seed();
    const ops = watchKvOps(kv);

    expect(await renewAuthToken(kv, USER1, auth)).toBeNull();

    expect(ops.writeTrail()).toEqual([]);
    expect(ops.getKeys()).toEqual([kvKeys.authToken(TOKEN)]);
  });

  it.each([
    { label: "there is no auth record", auth: null },
    {
      label: "the auth record has an empty token",
      auth: { token: "", createdAt: CREATED_AT },
    },
  ])("returns null without any KV op when $label", async ({ auth }) => {
    await kv.put(kvKeys.authToken(""), USER1);
    const ops = watchKvOps(kv);

    expect(await renewAuthToken(kv, USER1, auth)).toBeNull();

    expect(ops.getKeys()).toEqual([]);
    expect(ops.writeTrail()).toEqual([]);
  });
});

describe("generateAuthToken — secretAt", () => {
  async function minted(): Promise<AuthRecord | null> {
    return kv.get<AuthRecord>(kvKeys.auth(USER1), "json");
  }

  it("writes an explicit secretAt, over the replaced record's", async () => {
    const token = await generateAuthToken(kv, USER1, record(1), SECRET_AT);

    expect(token).toMatch(HEX_64);
    expect((await minted())?.secretAt).toBe(SECRET_AT);
  });

  it("carries the replaced record's secretAt when none is given", async () => {
    await kv.put(kvKeys.auth(USER1), JSON.stringify(record(SECRET_AT)));
    await kv.put(kvKeys.authToken(TOKEN), USER1);

    const token = await generateAuthToken(kv, USER1);

    expect(token).not.toBe(TOKEN);
    expect(await minted()).toEqual({
      token,
      createdAt: expect.any(String),
      secretAt: SECRET_AT,
    });
    expect(await kv.get(kvKeys.authToken(TOKEN))).toBeNull();
  });

  it.each([
    { label: "no record was found", known: null },
    { label: "the replaced record has none", known: record() },
  ])("omits secretAt when $label", async ({ known }) => {
    await generateAuthToken(kv, USER1, known);

    expect(await minted()).not.toHaveProperty("secretAt");
  });
});
