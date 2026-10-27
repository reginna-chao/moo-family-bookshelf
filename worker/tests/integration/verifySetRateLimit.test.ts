import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, tokenFor } from "../helpers/auth";
import { ALICE, BOB } from "../helpers/ids";
import { kvKeys } from "../../src/kv/schema";
import {
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import { VERIFY_SET_LIMIT, VERIFY_WRITE_LIMIT } from "../../src/routes/verify";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
} from "../../src/services/verification";

/**
 * `PUT /api/user/:id/verify`'s own per-userId ceiling, `verify-set` (#396).
 *
 * Charged only AFTER the body format checks, the current-token 401 and the
 * current-secret step-up — so a request refused by any of them (400 / 401 /
 * 403) costs no slot, and on a PIN / pattern account only someone who knows
 * the secret can spend the owner's 30 changes an hour. A wrong `currentSecret`
 * is a guess: it charges the gate's `verify` ceiling, never `verify-set`.
 *
 * Separate scopes: PUT no longer charges the `verify-write` scope shared by
 * OTP / prompted / qr-token, so a spent `verify-write` window does not block a
 * PUT with the correct secret, and a spent `verify-set` window does not block
 * an OTP. The three counter prefixes must not alias each other.
 *
 * Requests run without DEV_MODE (DEV_MODE skips every ceiling) and carry the
 * binding stubs, so only the hourly KV counters are written; setup goes
 * through DEV_MODE. `Date` is pinned mid-window, which also fixes `retryAfter`
 * at half the window.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const OTHER_ID = BOB;
const PIN = "123456";
const WRONG_PIN = "000000";
const WINDOW_MS = VERIFY_SET_LIMIT.windowSec * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;

async function call(
  method: string,
  path: string,
  token: string | undefined,
  body: string,
  dev = false,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const env = dev
    ? { KV: kv, DEV_MODE: "1" }
    : { KV: kv, ...rateLimitBindings() };
  return app.request(path, { method, headers, body }, env);
}

function putVerify(
  token: string | undefined,
  body: unknown,
): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return call("PUT", `/api/user/${USER_ID}/verify`, token, raw);
}

/** Configure `method` under DEV_MODE (no ceiling charged); returns the token now current. */
async function setUp(method: string, secret?: string): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await call(
    "PUT",
    `/api/user/${USER_ID}/verify`,
    seeded,
    JSON.stringify({ method, secret }),
    true,
  );
  expect(res.status).toBe(200);
  return (((await res.json()) as Json).data.authToken as string) ?? seeded;
}

type Limit = { scope: string; max: number; windowSec: number };

async function counterKey(limit: Limit): Promise<string> {
  return (await peekPerUserRateLimit(kv, { userId: USER_ID, ...limit })).key;
}

const ATTEMPT_LIMIT: Limit = {
  scope: VERIFY_ATTEMPT_SCOPE,
  max: VERIFY_ATTEMPT_MAX,
  windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
};
const setKey = () => counterKey(VERIFY_SET_LIMIT);
const writeKey = () => counterKey(VERIFY_WRITE_LIMIT);
const attemptKey = () => counterKey(ATTEMPT_LIMIT);

async function count(key: string): Promise<number | null> {
  const raw = await kv.get(key);
  return raw === null ? null : parseInt(raw, 10);
}

async function spend(key: string, used: number): Promise<void> {
  await kv.put(key, String(used), {
    expirationTtl: VERIFY_SET_LIMIT.windowSec * 2,
  });
}

function otp(token: string): Promise<Response> {
  return call("POST", `/api/user/${USER_ID}/verify/otp`, token, "{}");
}

beforeEach(() => {
  kv = createMockKV();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("verify-set ceiling — charged only after the step-up", () => {
  it("is its own scope, under a prefix that aliases neither verify-write nor verify", async () => {
    expect(VERIFY_SET_LIMIT).toEqual({
      scope: "verify-set",
      max: 30,
      windowSec: 3600,
    });
    const prefixes = [await setKey(), await writeKey(), await attemptKey()].map(
      (k) => k.slice(0, k.indexOf(USER_ID)),
    );
    for (const a of prefixes) {
      for (const b of prefixes)
        if (a !== b) expect(a.startsWith(b)).toBe(false);
    }
  });

  it("charges exactly one verify-set slot for a passing PUT, with a self-expiring counter, and no verify-write slot", async () => {
    const token = await setUp("pin", PIN);

    const res = await putVerify(token, { method: "none", currentSecret: PIN });

    expect(res.status).toBe(200);
    expect(await count(await setKey())).toBe(1);
    expect(getPutTtl(kv, await setKey())).toBe(VERIFY_SET_LIMIT.windowSec * 2);
    expect(await count(await writeKey())).toBeNull();
    expect(await count(await attemptKey())).toBeNull();
  });

  it.each([
    { label: "unparseable JSON", body: "{oops", status: 400 },
    {
      label: "an unknown method",
      body: { method: "sms", currentSecret: PIN },
      status: 400,
    },
    {
      label: "a malformed new PIN",
      body: { method: "pin", secret: "12", currentSecret: PIN },
      status: 400,
    },
    {
      label: "a non-string currentSecret",
      body: { method: "none", currentSecret: 123456 },
      status: 400,
    },
    { label: "a missing currentSecret", body: { method: "none" }, status: 403 },
    {
      label: "a wrong currentSecret",
      body: { method: "none", currentSecret: WRONG_PIN },
      status: 403,
    },
  ])(
    "does not charge verify-set for $label ($status)",
    async ({ body, status }) => {
      const token = await setUp("pin", PIN);

      const res = await putVerify(token, body);

      expect(res.status).toBe(status);
      expect(await count(await setKey())).toBeNull();
      expect(await count(await writeKey())).toBeNull();
    },
  );

  it("charges a wrong currentSecret to the gate's verify ceiling, not to verify-set", async () => {
    const token = await setUp("pin", PIN);

    await putVerify(token, { method: "none", currentSecret: WRONG_PIN });

    expect(await count(await attemptKey())).toBe(1);
    expect(await count(await setKey())).toBeNull();
  });

  it.each([
    { label: "no token", token: () => Promise.resolve(undefined) },
    { label: "another user's token", token: () => seedAuthToken(kv, OTHER_ID) },
    {
      label: "a revoked bearer a stale colo still accepts",
      token: async () => {
        await kv.put(kvKeys.authToken(tokenFor(USER_ID)), USER_ID);
        return tokenFor(USER_ID);
      },
    },
  ])(
    "answers $label with 401 without charging any ceiling",
    async ({ token }) => {
      await setUp("pin", PIN);

      const res = await putVerify(await token(), {
        method: "none",
        currentSecret: PIN,
      });

      expect(res.status).toBe(401);
      expect(await count(await setKey())).toBeNull();
      expect(await count(await attemptKey())).toBeNull();
    },
  );
});

describe("verify-set ceiling — once spent", () => {
  it("refuses a PUT with the correct secret with 429, writing nothing", async () => {
    const token = await setUp("pin", PIN);
    await spend(await setKey(), VERIFY_SET_LIMIT.max);
    const recordBefore = await kv.get(kvKeys.verify(USER_ID));

    const res = await putVerify(token, { method: "none", currentSecret: PIN });

    expect(res.status).toBe(429);
    const { error } = (await res.json()) as Json;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toBe(RATE_LIMITED_MESSAGE);
    expect(error.retryAfter).toBe(Math.ceil(VERIFY_SET_LIMIT.windowSec / 2));
    expect(await kv.get(kvKeys.verify(USER_ID))).toBe(recordBefore);
    expect(await count(await setKey())).toBe(VERIFY_SET_LIMIT.max);
  });

  it("still answers the step-up first: a missing or wrong secret gets 403, not 429", async () => {
    const token = await setUp("pin", PIN);
    await spend(await setKey(), VERIFY_SET_LIMIT.max);

    const missing = await putVerify(token, { method: "none" });
    const wrong = await putVerify(token, {
      method: "none",
      currentSecret: WRONG_PIN,
    });

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
  });

  it("does not block an OTP, which stays on verify-write", async () => {
    const token = await setUp("code");
    await spend(await setKey(), VERIFY_SET_LIMIT.max);

    expect((await putVerify(token, { method: "code" })).status).toBe(429);
    expect((await otp(token)).status).toBe(200);
    expect(await count(await writeKey())).toBe(1);
  });
});

describe("verify-write ceiling — no longer covers PUT", () => {
  it("lets a PUT with the correct secret through after OTP, prompted and qr-token spent verify-write", async () => {
    const token = await setUp("pin", PIN);
    await spend(await writeKey(), VERIFY_WRITE_LIMIT.max);
    const prompted = await call(
      "POST",
      `/api/user/${USER_ID}/verify/prompted`,
      token,
      "{}",
    );
    const qr = await call("POST", `/api/user/${USER_ID}/qr-token`, token, "{}");
    expect([prompted.status, qr.status, (await otp(token)).status]).toEqual([
      429, 429, 429,
    ]);

    const res = await putVerify(token, { method: "none", currentSecret: PIN });

    expect(res.status).toBe(200);
    expect(await count(await writeKey())).toBe(VERIFY_WRITE_LIMIT.max);
    expect(await count(await setKey())).toBe(1);
  });
});
