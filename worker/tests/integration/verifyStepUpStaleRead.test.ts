import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import { kvKeys, type VerifyRecord } from "../../src/kv/schema";

/**
 * Stale `verify:` read on the #396 step-up, whatever the record's shape.
 *
 * A colo whose `auth:{userId}` is current (`secretAt` = the latest PIN
 * rotation) but whose `verify:{userId}` read is stale — absent, an old
 * `none` / `code` record with `secretUpdatedAt` older than `secretAt`, or the
 * unstamped `none` record `defaultVerifyRecord()` writes (no
 * `secretUpdatedAt` at all) — has not seen the owner's PIN. A current-token holder without the PIN must not
 * get through it: `PUT /api/user/:id/verify { method: "none" }` and
 * `DELETE /api/user/:id` with no `currentSecret` both answer
 * `403 VERIFICATION_REQUIRED` and write nothing (no guess counter, no
 * `verify:` write, token and `auth:` unchanged, no account key deleted).
 *
 * The mock KV has no propagation lag, so the stale read is staged by hand:
 * set a PIN through the real PUT (writes `auth:.secretAt`, rotates the
 * token), then delete or overwrite `verify:` while `auth:` stays as written.
 *
 * Controls: a PIN account that switched to `none` WITH its PIN holds a record
 * at least as new as `secretAt`, so a later PUT — or a body-less DELETE —
 * needs no `currentSecret` even though `auth:.secretAt` is set.
 *
 * Requests run without DEV_MODE (binding stubs keep the per-IP tier off KV);
 * PIN setup goes through DEV_MODE.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const PIN = "123456";
const CALLER_IP = "203.0.113.30";
const SET_AT = Date.parse("2026-01-01T00:30:00.000Z");

async function request(
  path: string,
  method: string,
  token: string,
  body: unknown,
  dev = false,
): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "cf-connecting-ip": CALLER_IP,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const env = dev ? { DEV_MODE: "1" } : rateLimitBindings();
  return app.request(path, init, { KV: kv, ...env });
}

const putVerify = (body: unknown, token: string, dev = false) =>
  request(`/api/user/${USER_ID}/verify`, "PUT", token, body, dev);

/** Set a PIN through the real route (DEV_MODE); returns the rotated, current token. */
async function setPin(): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await putVerify({ method: "pin", secret: PIN }, seeded, true);
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

const STALE_SHAPES = ["absent", "none", "code", "none-unstamped"] as const;
type StaleShape = (typeof STALE_SHAPES)[number];

/**
 * Replace `verify:` with what a lagging colo would read: nothing, an older `none` / `code`
 * record, or the unstamped `none` that `defaultVerifyRecord()` writes (no `secretUpdatedAt`).
 */
async function stageStaleRead(shape: StaleShape): Promise<void> {
  const auth = (await kv.get(kvKeys.auth(USER_ID), "json")) as Json;
  expect(typeof auth.secretAt).toBe("number");
  if (shape === "absent") {
    await kv.delete(kvKeys.verify(USER_ID));
    return;
  }
  // Same field set as `defaultVerifyRecord()` in src/routes/verify.ts: no `secretUpdatedAt`.
  const unstamped: VerifyRecord = {
    method: "none",
    hash: null,
    salt: null,
    prompted: 0,
  };
  const old: VerifyRecord =
    shape === "none-unstamped"
      ? unstamped
      : {
          ...unstamped,
          method: shape,
          secretUpdatedAt: auth.secretAt - 60_000,
        };
  await kv.put(kvKeys.verify(USER_ID), JSON.stringify(old));
}

/** Every value a refusal must leave identical, books record included. */
function accountState(token: string): Promise<(string | null)[]> {
  return Promise.all(
    [
      kvKeys.verify(USER_ID),
      kvKeys.auth(USER_ID),
      kvKeys.authToken(token),
      kvKeys.user(USER_ID),
    ].map((key) => kv.get(key)),
  );
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as Json).error.code as string;
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SET_AT);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PUT /api/user/:id/verify — stale verify read after a PIN rotation", () => {
  it.each(STALE_SHAPES)(
    "refuses { method: none } without currentSecret on a stale %s read, writing nothing",
    async (shape) => {
      const token = await setPin();
      await stageStaleRead(shape);
      const before = await accountState(token);
      const ops = watchKvOps(kv);

      const res = await putVerify({ method: "none" }, token);

      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("VERIFICATION_REQUIRED");
      expect(ops.writeTrail()).toEqual([]);
      expect(await kv.get(kvKeys.verifyFail(USER_ID, CALLER_IP))).toBeNull();
      expect(await accountState(token)).toEqual(before);
    },
  );

  it("still lets an account that switched PIN ⇒ none with its PIN save without currentSecret", async () => {
    const token = await setPin();
    vi.setSystemTime(SET_AT + 1000);
    const off = await putVerify({ method: "none", currentSecret: PIN }, token);
    expect(off.status).toBe(200);

    const res = await putVerify({ method: "code" }, token);

    expect(res.status).toBe(200);
    const record = (await kv.get(
      kvKeys.verify(USER_ID),
      "json",
    )) as VerifyRecord;
    expect(record.method).toBe("code");
  });
});

describe("DELETE /api/user/:id — stale verify read after a PIN rotation", () => {
  it.each(STALE_SHAPES)(
    "refuses a body-less DELETE on a stale %s read and deletes nothing",
    async (shape) => {
      const token = await setPin();
      const books = { schemaVersion: 1, userId: USER_ID, books: [] };
      await kv.put(kvKeys.user(USER_ID), JSON.stringify(books));
      await stageStaleRead(shape);
      const before = await accountState(token);
      const ops = watchKvOps(kv);

      const res = await request(
        `/api/user/${USER_ID}`,
        "DELETE",
        token,
        undefined,
      );

      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("VERIFICATION_REQUIRED");
      expect(ops.writeTrail()).toEqual([]);
      expect(await accountState(token)).toEqual(before);
      expect(await kv.get(kvKeys.authToken(token))).toBe(USER_ID);
      expect(await kv.get(kvKeys.user(USER_ID))).not.toBeNull();
    },
  );

  it("still deletes an account that switched PIN ⇒ none with its PIN, without currentSecret", async () => {
    const token = await setPin();
    vi.setSystemTime(SET_AT + 1000);
    const off = await putVerify({ method: "none", currentSecret: PIN }, token);
    expect(off.status).toBe(200);
    // Not stale only because the record is newer: `secretAt` must still be set.
    const auth = (await kv.get(kvKeys.auth(USER_ID), "json")) as Json;
    expect(typeof auth.secretAt).toBe("number");
    const record = (await kv.get(
      kvKeys.verify(USER_ID),
      "json",
    )) as VerifyRecord;
    expect(record.method).toBe("none");
    expect(record.secretUpdatedAt).toBeGreaterThanOrEqual(auth.secretAt);

    const res = await request(
      `/api/user/${USER_ID}`,
      "DELETE",
      token,
      undefined,
    );

    expect(res.status).toBe(200);
    expect(await kv.get(kvKeys.verify(USER_ID))).toBeNull();
    expect(await kv.get(kvKeys.auth(USER_ID))).toBeNull();
  });
});
