import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import { kvKeys } from "../../src/kv/schema";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import { VERIFY_SET_LIMIT } from "../../src/routes/verify";
import { VERIFY_SECRET_MAX_LENGTH } from "../../src/utils/validation";

/**
 * What the `PUT /api/user/:id/verify` step-up (#396) costs: format refusals and
 * KV reads. The step-up's outcomes live in `verifyStepUp.test.ts`.
 *
 * Format: `currentSecret` is classified by `sanitizeVerifySecret` with the
 * other body checks — any non-string or an over-long string is
 * `400 INVALID_VERIFY_SECRET`, naming the field, before the handler reads the
 * account (no `verify:` read, no write).
 *
 * Read budget: the handler reads `verify:{userId}` ONCE and hands it to the
 * gate, so the step-up never re-reads it. Against the pre-#396 PUT
 * (`token:`, `auth:`, `verify:`, the hourly counter), the only read added is the
 * caller's `verifyfail:` entry, and only on a PIN / pattern account; a `none`
 * account reads the same number of keys (the counter is now `verify-set`).
 *
 * Requests run without DEV_MODE, with the binding stubs, so the hourly counter
 * read is real and the per-IP tier stays off KV; setup goes through DEV_MODE.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const PIN = "123456";
const CALLER_IP = "203.0.113.9";
const FAIL_KEY = kvKeys.verifyFail(USER_ID, CALLER_IP);
const WINDOW_MS = VERIFY_SET_LIMIT.windowSec * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;

async function send(
  body: unknown,
  token: string,
  dev = false,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "cf-connecting-ip": CALLER_IP,
  };
  const env = dev
    ? { KV: kv, DEV_MODE: "1" }
    : { KV: kv, ...rateLimitBindings() };
  return app.request(
    `/api/user/${USER_ID}/verify`,
    { method: "PUT", headers, body: JSON.stringify(body) },
    env,
  );
}

/** Configure `method` through the real route (DEV_MODE); returns the token now current. */
async function setUp(method: string, secret?: string): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await send({ method, secret }, seeded, true);
  expect(res.status).toBe(200);
  return (((await res.json()) as Json).data.authToken as string) ?? seeded;
}

async function setCounterKey(): Promise<string> {
  return (
    await peekPerUserRateLimit(kv, { userId: USER_ID, ...VERIFY_SET_LIMIT })
  ).key;
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PUT /api/user/:id/verify — currentSecret format", () => {
  it.each([
    { label: "a number", value: 123456 },
    { label: "an object", value: { pin: PIN } },
    {
      label: "an over-long string",
      value: "1".repeat(VERIFY_SECRET_MAX_LENGTH + 1),
    },
  ])(
    "answers $label with 400 INVALID_VERIFY_SECRET before reading the account",
    async ({ value }) => {
      const token = await setUp("pin", PIN);
      const ops = watchKvOps(kv);

      const res = await send({ method: "none", currentSecret: value }, token);

      expect(res.status).toBe(400);
      expect(((await res.json()) as Json).error).toEqual({
        code: "INVALID_VERIFY_SECRET",
        message: `currentSecret must be a string of ${VERIFY_SECRET_MAX_LENGTH} characters or fewer`,
      });
      expect(ops.getKeys()).not.toContain(kvKeys.verify(USER_ID));
      expect(ops.writeTrail()).toEqual([]);
    },
  );
});

describe("PUT /api/user/:id/verify — read budget", () => {
  it("reads verify:{userId} once and adds only the caller's verifyfail read on a PIN account", async () => {
    const token = await setUp("pin", PIN);
    const setKey = await setCounterKey();
    const ops = watchKvOps(kv);

    const res = await send({ method: "none", currentSecret: PIN }, token);

    expect(res.status).toBe(200);
    expect([...ops.getKeys()].sort()).toEqual(
      [
        kvKeys.authToken(token),
        kvKeys.auth(USER_ID),
        kvKeys.verify(USER_ID),
        FAIL_KEY,
        setKey,
      ].sort(),
    );
  });

  it("reads as many keys as before #396 on a none account (no verifyfail read)", async () => {
    const token = await setUp("none");
    const setKey = await setCounterKey();
    const ops = watchKvOps(kv);

    const res = await send({ method: "code" }, token);

    expect(res.status).toBe(200);
    expect([...ops.getKeys()].sort()).toEqual(
      [
        kvKeys.authToken(token),
        kvKeys.auth(USER_ID),
        kvKeys.verify(USER_ID),
        setKey,
      ].sort(),
    );
  });
});
