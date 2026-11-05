import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, tokenOwner, authTokenKey } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import { kvKeys } from "../../src/kv/schema";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
  VERIFY_STEP_UP_ATTEMPT_SCOPE,
} from "../../src/services/verification";

/**
 * The two guess budgets on the `DELETE /api/user/:id` step-up (#396).
 *
 * The step-up has its own budget (`verify-stepup`). With it spent, a correct and
 * a wrong `currentSecret` both answer `429 RATE_LIMITED`, nothing is written and
 * nothing is deleted. With the public login budget (`verify`) spent, the correct
 * secret still deletes the account: public login traffic never measures against
 * this path. The rest of the DELETE step-up contract is in
 * `userDeleteStepUp.test.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const PIN = "123456";
const WRONG_PIN = "000000";
const CALLER_IP = "203.0.113.21";

async function call(
  path: string,
  method: string,
  token: string,
  body: unknown,
  env: Record<string, unknown>,
): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "cf-connecting-ip": CALLER_IP,
  };
  const init = { method, headers, body: JSON.stringify(body) };
  return app.request(path, init, { KV: kv, ...env });
}

function deleteAccount(token: string, currentSecret: string) {
  const env = rateLimitBindings();
  return call(`/api/user/${USER_ID}`, "DELETE", token, { currentSecret }, env);
}

/** Set `pin` on USER_ID through the real route (DEV_MODE); returns the rotated, current token. */
async function setPin(pin: string): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const body = { method: "pin", secret: pin };
  const res = await call(`/api/user/${USER_ID}/verify`, "PUT", seeded, body, {
    DEV_MODE: "1",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

async function spendBudget(scope: string): Promise<string> {
  const { key } = await peekPerUserRateLimit(kv, {
    userId: USER_ID,
    scope,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  await kv.put(key, String(VERIFY_ATTEMPT_MAX));
  return key;
}

beforeEach(() => {
  kv = createMockKV();
  // Mid-hour pin: the budget key seeded before a request names the bucket it reads.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-01-01T00:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DELETE /api/user/:id — guess budgets", () => {
  it("with the step-up budget spent, answers a wrong and the correct PIN alike with 429, deleting nothing", async () => {
    const token = await setPin(PIN);
    const stepUpKey = await spendBudget(VERIFY_STEP_UP_ATTEMPT_SCOPE);
    const ops = watchKvOps(kv);

    const wrong = await deleteAccount(token, WRONG_PIN);
    const right = await deleteAccount(token, PIN);

    expect(wrong.status).toBe(429);
    expect(right.status).toBe(429);
    const wrongBody = await wrong.text();
    expect(await right.text()).toBe(wrongBody);
    const { error } = JSON.parse(wrongBody) as Json;
    expect(error.code).toBe("RATE_LIMITED");
    expect(typeof error.retryAfter).toBe("number");
    expect(ops.writeTrail()).toEqual([]);
    expect(await kv.get(kvKeys.verify(USER_ID))).not.toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER_ID);
    expect(await kv.get(stepUpKey)).toBe(String(VERIFY_ATTEMPT_MAX));
  });

  it("with the login budget spent, still deletes with the correct PIN, charging no budget", async () => {
    const token = await setPin(PIN);
    await spendBudget(VERIFY_ATTEMPT_SCOPE);
    const { key: stepUpKey } = await peekPerUserRateLimit(kv, {
      userId: USER_ID,
      scope: VERIFY_STEP_UP_ATTEMPT_SCOPE,
      max: VERIFY_ATTEMPT_MAX,
      windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
    });

    const res = await deleteAccount(token, PIN);

    expect(res.status).toBe(200);
    expect(await kv.get(stepUpKey)).toBeNull();
    for (const key of [
      kvKeys.verify(USER_ID),
      kvKeys.auth(USER_ID),
      await authTokenKey(token),
    ]) {
      expect(await kv.get(key)).toBeNull();
    }
  });
});
