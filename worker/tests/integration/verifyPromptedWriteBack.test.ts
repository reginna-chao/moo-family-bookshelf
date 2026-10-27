import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { createRateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, tokenFor } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE, BOB } from "../helpers/ids";
import {
  kvKeys,
  type AuthRecord,
  type VerifyRecord,
} from "../../src/kv/schema";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import { VERIFY_WRITE_LIMIT } from "../../src/routes/verify";

/**
 * `POST /api/user/:id/verify/prompted` write-back guards (#378).
 *
 * The handler charges the shared `verify-write` ceiling, then reads
 * `verify:{userId}` and `auth:{userId}` together and decides:
 *
 * - Stale bearer: `token:{T}` still maps to the user (a colo that missed a
 *   rotation's delete) while `auth:{userId}` names another token. Bearer
 *   currency says T is NOT current → `401 UNAUTHORIZED`, nothing written past
 *   the counter slot it already spent.
 * - Already prompted: `prompted === 1` → `200 { method, prompted: 1 }` and no
 *   `verify:` write — rewriting it would only risk a stale copy.
 * - Stale verify read: `auth.secretAt` (stamped by the last PIN / pattern
 *   rotation) newer than the read record's `secretUpdatedAt`, or the record
 *   lacks it, or the read came back null. Writing back would replace the
 *   current PIN with an older record (or erase it with the default one), so the
 *   handler answers `200` without writing. A null read reports `method: "none"`.
 * - Otherwise the write proceeds as before: `existing ?? defaultVerifyRecord()`
 *   with `prompted = 1`. That includes the TTL gap (no `auth:` record — the
 *   bearer counts as current) and a `secretAt` EQUAL to `secretUpdatedAt`
 *   (the record IS the rotation's own), the positive companions of the
 *   no-write cases.
 *
 * Every request runs WITHOUT DEV_MODE (with the Rate Limiting binding stubs),
 * so the hourly `verify-write` KV counter is live and its `put` is the first
 * entry of every write trail — the counter key is built by the production
 * `peekPerUserRateLimit`. `Date` is pinned mid-window so the bucket cannot roll
 * over between the request and the key lookup.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const TOKEN = tokenFor(USER_ID);
const OTHER_TOKEN = tokenFor(BOB);
const WINDOW_MS = VERIFY_WRITE_LIMIT.windowSec * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-03-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;
const ROTATED_AT = PINNED_NOW - 60_000;

const PIN_RECORD: VerifyRecord = {
  method: "pin",
  hash: "a".repeat(64),
  salt: "b".repeat(32),
  prompted: 0,
  secretUpdatedAt: ROTATED_AT - 1,
};

async function postPrompted(token: string): Promise<Response> {
  return app.request(
    `/api/user/${USER_ID}/verify/prompted`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    },
    { KV: kv, ...createRateLimitBindings().bindings },
  );
}

async function writeCounterPut(): Promise<string> {
  const { key } = await peekPerUserRateLimit(kv, {
    userId: USER_ID,
    ...VERIFY_WRITE_LIMIT,
  });
  return `put ${key}`;
}

/** Overwrite `auth:{userId}` while `token:{TOKEN}` stays — the bearer pair. */
async function seedAuthRecord(record: AuthRecord): Promise<void> {
  await kv.put(kvKeys.auth(USER_ID), JSON.stringify(record));
}

async function seedVerify(record: VerifyRecord): Promise<string> {
  const raw = JSON.stringify(record);
  await kv.put(kvKeys.verify(USER_ID), raw);
  return raw;
}

beforeEach(async () => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  await seedAuthToken(kv, USER_ID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/user/:id/verify/prompted — stale bearer", () => {
  it("answers 401 for a bearer auth: no longer names, writing only the counter slot", async () => {
    await seedAuthRecord({ token: OTHER_TOKEN, createdAt: "x" });
    const verifyRaw = await seedVerify(PIN_RECORD);
    const ops = watchKvOps(kv);

    const res = await postPrompted(TOKEN);

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(json.error.message).toBe("Authentication required");
    expect(ops.writeTrail()).toEqual([await writeCounterPut()]);
    expect(await kv.get(kvKeys.verify(USER_ID))).toBe(verifyRaw);
  });
});

describe("POST /api/user/:id/verify/prompted — no write-back", () => {
  it("answers 200 without writing when the record is already prompted", async () => {
    const verifyRaw = await seedVerify({
      method: "code",
      hash: null,
      salt: null,
      prompted: 1,
    });
    const ops = watchKvOps(kv);

    const res = await postPrompted(TOKEN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { method: "code", prompted: 1 },
    });
    expect(ops.writeTrail()).toEqual([await writeCounterPut()]);
    expect(await kv.get(kvKeys.verify(USER_ID))).toBe(verifyRaw);
  });

  it.each([
    { label: "an older secretUpdatedAt", record: PIN_RECORD },
    {
      label: "no secretUpdatedAt",
      record: { ...PIN_RECORD, secretUpdatedAt: undefined },
    },
  ])(
    "keeps the stored PIN record byte-identical when auth.secretAt is newer than $label",
    async ({ record }) => {
      await seedAuthRecord({
        token: TOKEN,
        createdAt: "x",
        secretAt: ROTATED_AT,
      });
      const verifyRaw = await seedVerify(record);
      const ops = watchKvOps(kv);

      const res = await postPrompted(TOKEN);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { method: "pin", prompted: 1 },
      });
      expect(ops.writeTrail()).toEqual([await writeCounterPut()]);
      expect(await kv.get(kvKeys.verify(USER_ID))).toBe(verifyRaw);
    },
  );

  it("writes no default record when auth.secretAt is set and the verify read is null", async () => {
    await seedAuthRecord({
      token: TOKEN,
      createdAt: "x",
      secretAt: ROTATED_AT,
    });
    const ops = watchKvOps(kv);

    const res = await postPrompted(TOKEN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { method: "none", prompted: 1 },
    });
    expect(ops.writeTrail()).toEqual([await writeCounterPut()]);
    expect(await kv.get(kvKeys.verify(USER_ID))).toBeNull();
  });
});

describe("POST /api/user/:id/verify/prompted — write proceeds", () => {
  it.each([
    {
      label: "no auth: record (TTL gap) and no verify record",
      auth: null,
      existing: null,
      stored: { method: "none", hash: null, salt: null, prompted: 1 },
    },
    {
      label: "a matching pair without secretAt",
      auth: { token: TOKEN, createdAt: "x" },
      existing: PIN_RECORD,
      stored: { ...PIN_RECORD, prompted: 1 },
    },
    {
      label: "secretAt equal to the record's secretUpdatedAt",
      auth: { token: TOKEN, createdAt: "x", secretAt: ROTATED_AT },
      existing: { ...PIN_RECORD, secretUpdatedAt: ROTATED_AT },
      stored: { ...PIN_RECORD, secretUpdatedAt: ROTATED_AT, prompted: 1 },
    },
  ])(
    "writes the record with prompted 1 for $label",
    async ({ auth, existing, stored }) => {
      if (auth === null) await kv.delete(kvKeys.auth(USER_ID));
      else await seedAuthRecord(auth);
      if (existing !== null) await seedVerify(existing);
      const ops = watchKvOps(kv);

      const res = await postPrompted(TOKEN);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { method: stored.method, prompted: 1 },
      });
      expect(ops.writeTrail()).toEqual([
        await writeCounterPut(),
        `put ${kvKeys.verify(USER_ID)}`,
      ]);
      const raw = await kv.get(kvKeys.verify(USER_ID));
      expect(JSON.parse(raw as string)).toEqual(stored);
    },
  );
});
