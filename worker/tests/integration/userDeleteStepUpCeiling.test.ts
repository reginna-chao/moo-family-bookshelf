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
} from "../../src/services/verification";

/**
 * Invariant 6 on the `DELETE /api/user/:id` step-up (#396).
 *
 * With the account's `verify` wrong-guess ceiling already spent, a wrong
 * `currentSecret` answers `429 RATE_LIMITED` and deletes nothing, while the
 * correct one is still admitted and charges nothing: a third party spending
 * the window can block guessing, never the owner's own deletion. The rest of
 * the DELETE step-up contract is in `userDeleteStepUp.test.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const PIN = "123456";
const WRONG_PIN = "000000";
const CALLER_IP = "203.0.113.21";
const FAIL_KEY = kvKeys.verifyFail(USER_ID, CALLER_IP);

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

beforeEach(() => {
  kv = createMockKV();
  // Mid-hour pin: the ceiling key seeded before a request names the bucket it reads.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-01-01T00:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DELETE /api/user/:id — guess ceiling already spent", () => {
  it("answers a wrong PIN 429 deleting nothing, and still deletes with the correct PIN uncharged", async () => {
    const token = await setPin(PIN);
    const ceilingKey = (
      await peekPerUserRateLimit(kv, {
        userId: USER_ID,
        scope: VERIFY_ATTEMPT_SCOPE,
        max: VERIFY_ATTEMPT_MAX,
        windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
      })
    ).key;
    await kv.put(ceilingKey, String(VERIFY_ATTEMPT_MAX));
    const ops = watchKvOps(kv);

    const wrong = await deleteAccount(token, WRONG_PIN);
    expect(wrong.status).toBe(429);
    const { error } = (await wrong.json()) as Json;
    expect(error.code).toBe("RATE_LIMITED");
    expect(typeof error.retryAfter).toBe("number");
    // Only the caller's streak may be written; the spent ceiling and every account key stay put.
    expect(ops.writeTrail()).toEqual([`put ${FAIL_KEY}`]);
    expect(await kv.get(kvKeys.verify(USER_ID))).not.toBeNull();
    expect(await tokenOwner(kv, token)).toBe(USER_ID);

    const right = await deleteAccount(token, PIN);
    expect(right.status).toBe(200);
    expect(await kv.get(ceilingKey)).toBe(String(VERIFY_ATTEMPT_MAX));
    for (const key of [
      kvKeys.verify(USER_ID),
      kvKeys.auth(USER_ID),
      await authTokenKey(token),
    ]) {
      expect(await kv.get(key)).toBeNull();
    }
  });
});
