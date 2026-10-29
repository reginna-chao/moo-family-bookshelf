import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken, tokenOwner } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import { kvKeys, type VerifyRecord } from "../../src/kv/schema";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import { VERIFY_SET_LIMIT } from "../../src/routes/verify";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
} from "../../src/services/verification";

/**
 * Current-secret step-up on `PUT /api/user/:id/verify` (#396).
 *
 * When the stored record is a configured PIN / pattern, every PUT — whatever
 * the target method — must carry the CURRENT secret as `currentSecret`.
 * Missing ⇒ `403 VERIFICATION_REQUIRED`, wrong ⇒ `403 VERIFICATION_FAILED`
 * (the gate's own answers, charging the caller's `verifyfail:{userId}:{ip}`
 * streak and the account's `verify` guess ceiling), correct ⇒ the save goes on
 * as before (rotation for a new PIN / pattern). A refused PUT leaves the record
 * and the session byte-identical. `none` / `code` / no record need nothing and
 * ignore a supplied secret; a corrupted PIN record (no hash / salt) behaves
 * like the gate: no secret ⇒ 403, any secret ⇒ pass.
 *
 * Stale record: when `auth:{userId}.secretAt` is newer than the record's
 * `secretUpdatedAt`, this colo has not seen the owner's latest secret; the
 * step-up answers `403 VERIFICATION_REQUIRED` without comparing, so even the
 * correct secret writes nothing and charges nothing.
 *
 * `currentSecret: null` / `""` mean "not supplied" (403, not 400); malformed
 * values and the KV read budget are in `verifyStepUpBudget.test.ts`.
 *
 * Requests run without DEV_MODE (binding stubs keep the per-IP tier off KV),
 * so the `verify` ceiling is really charged; setup goes through DEV_MODE.
 * `Date` is pinned mid-window so no counter bucket rolls over.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const USER_ID = ALICE;
const PIN = "123456";
const NEW_PIN = "654321";
const WRONG_PIN = "000000";
const PATTERN = "0,1,2,5,8";
const CALLER_IP = "203.0.113.9";
const WINDOW_MS = VERIFY_ATTEMPT_WINDOW_SECONDS * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;
const FAIL_KEY = kvKeys.verifyFail(USER_ID, CALLER_IP);

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

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as Json).error.code as string;
}

async function attemptCounterKey(): Promise<string> {
  const reading = await peekPerUserRateLimit(kv, {
    userId: USER_ID,
    scope: VERIFY_ATTEMPT_SCOPE,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  return reading.key;
}

async function setCounterKey(): Promise<string> {
  return (
    await peekPerUserRateLimit(kv, { userId: USER_ID, ...VERIFY_SET_LIMIT })
  ).key;
}

/** Raw `verify:` / `auth:` / `token:` values — what a refusal must leave identical. */
async function snapshot(token: string): Promise<(string | null)[]> {
  return Promise.all([
    kv.get(kvKeys.verify(USER_ID)),
    kv.get(kvKeys.auth(USER_ID)),
    tokenOwner(kv, token),
  ]);
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

describe("PUT /api/user/:id/verify — step-up on a PIN account", () => {
  it("refuses a PUT without currentSecret with 403 VERIFICATION_REQUIRED, writing nothing", async () => {
    const token = await setUp("pin", PIN);
    const before = await snapshot(token);
    const ops = watchKvOps(kv);

    const res = await send({ method: "pin", secret: NEW_PIN }, token);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("VERIFICATION_REQUIRED");
    expect(ops.writeTrail()).toEqual([]);
    expect(await snapshot(token)).toEqual(before);
  });

  it("refuses a wrong currentSecret with 403 VERIFICATION_FAILED, charging only the guess counters", async () => {
    const token = await setUp("pin", PIN);
    const before = await snapshot(token);
    const ops = watchKvOps(kv);

    const res = await send(
      { method: "pin", secret: NEW_PIN, currentSecret: WRONG_PIN },
      token,
    );

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("VERIFICATION_FAILED");
    expect([...ops.writeTrail()].sort()).toEqual(
      [`put ${await attemptCounterKey()}`, `put ${FAIL_KEY}`].sort(),
    );
    expect(await kv.get(await setCounterKey())).toBeNull();
    expect(((await kv.get(FAIL_KEY, "json")) as Json).failCount).toBe(1);
    expect(await snapshot(token)).toEqual(before);
  });

  it("saves and rotates the token with the correct currentSecret, clearing the caller's failure streak", async () => {
    const token = await setUp("pin", PIN);
    await send(
      { method: "pin", secret: NEW_PIN, currentSecret: WRONG_PIN },
      token,
    );
    expect(await kv.get(FAIL_KEY)).not.toBeNull();

    const res = await send(
      { method: "pin", secret: NEW_PIN, currentSecret: PIN },
      token,
    );

    expect(res.status).toBe(200);
    const rotated = ((await res.json()) as Json).data.authToken as string;
    expect(rotated).not.toBe(token);
    expect(await tokenOwner(kv, token)).toBeNull();
    expect(await kv.get(FAIL_KEY)).toBeNull();
    expect(await kv.get(await setCounterKey())).toBe("1");
  });

  it("with the guess ceiling spent, answers a wrong secret 429 and still admits the correct one uncharged", async () => {
    const token = await setUp("pin", PIN);
    const ceilingKey = await attemptCounterKey();
    await kv.put(ceilingKey, String(VERIFY_ATTEMPT_MAX));
    const before = await snapshot(token);

    const wrong = await send(
      { method: "none", currentSecret: WRONG_PIN },
      token,
    );
    expect(wrong.status).toBe(429);
    const { error } = (await wrong.json()) as Json;
    expect(error.code).toBe("RATE_LIMITED");
    expect(typeof error.retryAfter).toBe("number");
    expect(await snapshot(token)).toEqual(before);

    const right = await send({ method: "none", currentSecret: PIN }, token);
    expect(right.status).toBe(200);
    expect(await kv.get(ceilingKey)).toBe(String(VERIFY_ATTEMPT_MAX));
  });

  it.each([
    { target: "pattern", body: { method: "pattern", secret: PATTERN } },
    { target: "none", body: { method: "none" } },
    { target: "code", body: { method: "code" } },
  ])(
    "requires the current PIN to switch to $target",
    async ({ target, body }) => {
      const token = await setUp("pin", PIN);
      const before = await snapshot(token);

      const refused = await send(body, token);
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toBe("VERIFICATION_REQUIRED");
      expect(await snapshot(token)).toEqual(before);

      const admitted = await send({ ...body, currentSecret: PIN }, token);
      expect(admitted.status).toBe(200);
      const record = (await kv.get(
        kvKeys.verify(USER_ID),
        "json",
      )) as VerifyRecord;
      expect(record.method).toBe(target);
    },
  );

  it("asks a pattern account for its current pattern", async () => {
    const token = await setUp("pattern", PATTERN);

    expect(
      (await send({ method: "none", currentSecret: PIN }, token)).status,
    ).toBe(403);
    expect(
      (await send({ method: "none", currentSecret: PATTERN }, token)).status,
    ).toBe(200);
  });

  it.each([{ currentSecret: null }, { currentSecret: "" }])(
    "treats currentSecret $currentSecret as not supplied (403, not 400)",
    async (extra) => {
      const token = await setUp("pin", PIN);
      const res = await send({ method: "none", ...extra }, token);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("VERIFICATION_REQUIRED");
    },
  );
});

describe("PUT /api/user/:id/verify — accounts with nothing to step up on", () => {
  it.each(["none", "code"])(
    "lets a %s account save without currentSecret, and ignores one it sends",
    async (method) => {
      const token = await setUp(method);
      const plain = await send({ method }, token);
      expect(plain.status).toBe(200);

      const ops = watchKvOps(kv);
      const withSecret = await send(
        { method, currentSecret: WRONG_PIN },
        token,
      );

      expect(withSecret.status).toBe(200);
      expect(ops.getKeys()).not.toContain(FAIL_KEY);
      expect(ops.writeTrail()).not.toContain(`put ${FAIL_KEY}`);
      expect(await kv.get(FAIL_KEY)).toBeNull();
      expect(await kv.get(await attemptCounterKey())).toBeNull();
      const record = (await kv.get(
        kvKeys.verify(USER_ID),
        "json",
      )) as VerifyRecord;
      expect(record.method).toBe(method);
    },
  );

  it("treats a corrupted PIN record like the gate: no secret ⇒ 403, any secret ⇒ 200", async () => {
    const token = await seedAuthToken(kv, USER_ID);
    const corrupted: VerifyRecord = {
      method: "pin",
      hash: null,
      salt: null,
      prompted: 1,
    };
    await kv.put(kvKeys.verify(USER_ID), JSON.stringify(corrupted));

    const refused = await send({ method: "none" }, token);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("VERIFICATION_REQUIRED");

    const admitted = await send(
      { method: "none", currentSecret: "anything" },
      token,
    );
    expect(admitted.status).toBe(200);
  });
});

describe("PUT /api/user/:id/verify — a stale verify record", () => {
  it("refuses even the correct secret with 403 VERIFICATION_REQUIRED, comparing and charging nothing", async () => {
    const token = await setUp("pin", PIN);
    const auth = (await kv.get(kvKeys.auth(USER_ID), "json")) as Json;
    expect(typeof auth.secretAt).toBe("number");
    // auth: was written for a NEWER secret than the record this colo holds.
    await kv.put(
      kvKeys.auth(USER_ID),
      JSON.stringify({ ...auth, secretAt: auth.secretAt + 1000 }),
    );
    const before = await snapshot(token);
    const ops = watchKvOps(kv);

    const res = await send({ method: "none", currentSecret: PIN }, token);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("VERIFICATION_REQUIRED");
    expect(ops.writeTrail()).toEqual([]);
    expect(ops.getKeys()).not.toContain(FAIL_KEY);
    expect(await kv.get(await attemptCounterKey())).toBeNull();
    expect(await snapshot(token)).toEqual(before);
  });
});
