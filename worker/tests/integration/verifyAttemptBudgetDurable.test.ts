import { inspect } from "node:util";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import {
  createProductionBindings,
  type ProductionBindings,
} from "../helpers/productionBindings";
import type { AttemptBudgetNamespaceFake } from "../helpers/attemptBudgetNamespace";
import {
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
} from "../../src/middleware/rateLimit";
import {
  VERIFY_ATTEMPT_MAX,
  VERIFY_ATTEMPT_SCOPE,
  VERIFY_ATTEMPT_WINDOW_SECONDS,
  VERIFY_STEP_UP_ATTEMPT_MAX,
  VERIFY_STEP_UP_ATTEMPT_SCOPE,
} from "../../src/services/verification";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * The verification gate's two hourly attempt budgets on the `ATTEMPT_BUDGET`
 * Durable Object, through the real Hono app.
 *
 * With the binding, every compared secret reserves a slot on the budget's
 * object first; a wrong guess keeps it, a correct one gets it back. So however
 * many requests arrive at once, at most `max` of them reach the comparison in
 * one window: the login budget (`verify:{userId}`, 10) and each token's step-up
 * budget (`verify-stepup:{userId}:{tokenHash}`, 5). An overloaded object answers
 * `429 RATE_LIMITED` with `retryAfter` 60 and compares nothing; any other object
 * error falls back to the KV counter, so a correct secret still gets in. A
 * successful `PUT /api/user/:id/verify` resets the login budget's object.
 *
 * Harness: production mode (no `DEV_MODE`) with `createProductionBindings()` —
 * the Rate Limiting stubs admit everything, and an in-memory namespace runs the
 * real `AttemptBudgetObject` (tests/helpers/attemptBudgetNamespace.ts). Every
 * request comes from a source address never used before, so the caller-scoped
 * lockout stays out of the way. The PIN is set through the real route under
 * DEV_MODE, which spends nothing. `Date` is pinned mid-window, so `retryAfter`
 * of a spent window is exactly half of it. The KV fallback's own behaviour is
 * in `verifyAttemptCeiling.test.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const USER_ID = ALICE;
const PIN = "123456";
const NEW_PIN = "654321";
const WRONG_PIN = "000000";
const WINDOW_MS = VERIFY_ATTEMPT_WINDOW_SECONDS * 1000;
const PINNED_NOW =
  Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / WINDOW_MS) * WINDOW_MS +
  WINDOW_MS / 2;
const BUCKET = Math.floor(PINNED_NOW / WINDOW_MS);
const LOOKUP_PATH = "/api/auth/lookup";
const VERIFY_PATH = `/api/user/${USER_ID}/verify`;
const LOGIN_BUDGET = `${VERIFY_ATTEMPT_SCOPE}:${USER_ID}`;
const BURST = 20;

let kv: KVNamespace;
let bindings: ProductionBindings;
let budget: AttemptBudgetNamespaceFake;
let sourceCounter = 0;

function freshIp(): string {
  sourceCounter += 1;
  return `203.0.${Math.floor(sourceCounter / 250)}.${sourceCounter % 250}`;
}

async function send(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; dev?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-connecting-ip": freshIp(),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const env = opts.dev ? { KV: kv, DEV_MODE: "1" } : { KV: kv, ...bindings };
  return app.request(path, init, env);
}

const lookup = (verifySecret: string) =>
  send("POST", LOOKUP_PATH, { body: { userId: USER_ID, verifySecret } });

const stepUp = (token: string, currentSecret: string) =>
  send("PUT", VERIFY_PATH, {
    body: { method: "none", currentSecret },
    token,
  });

/** Set a real PIN through the route (DEV_MODE); returns the token now current. */
async function setPin(pin: string): Promise<string> {
  const seeded = await seedAuthToken(kv, USER_ID);
  const res = await send("PUT", VERIFY_PATH, {
    body: { method: "pin", secret: pin },
    token: seeded,
    dev: true,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.authToken as string;
}

/** The KV fallback counter of the login budget's current window. */
async function loginCounterKey(): Promise<string> {
  const { key } = await peekPerUserRateLimit(kv, {
    userId: USER_ID,
    scope: VERIFY_ATTEMPT_SCOPE,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  return key;
}

async function errorCodes(responses: Response[]): Promise<string[]> {
  return Promise.all(
    responses.map(async (res) => ((await res.json()) as Json).error.code),
  );
}

function count(codes: string[], code: string): number {
  return codes.filter((c) => c === code).length;
}

/** Silence and record `console.error`; `text()` is everything logged, deep. */
function captureErrors() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    calls: () => spy.mock.calls,
    text: () => inspect(spy.mock.calls, { depth: 6 }),
  };
}

const RATE_LIMITED_BODY = (retryAfter: number) => ({
  error: { code: "RATE_LIMITED", message: RATE_LIMITED_MESSAGE, retryAfter },
});

beforeEach(() => {
  kv = createMockKV();
  ({ bindings, namespace: budget } = createProductionBindings());
  sourceCounter = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hourly attempt budgets — at most max comparisons per window under concurrency", () => {
  it("lets exactly 5 of 20 concurrent wrong currentSecrets on one token reach the comparison", async () => {
    const token = await setPin(PIN);
    const errors = captureErrors();

    const responses = await Promise.all(
      Array.from({ length: BURST }, () => stepUp(token, WRONG_PIN)),
    );

    const codes = await errorCodes(responses);
    expect(count(codes, "VERIFICATION_FAILED")).toBe(
      VERIFY_STEP_UP_ATTEMPT_MAX,
    );
    expect(count(codes, "RATE_LIMITED")).toBe(
      BURST - VERIFY_STEP_UP_ATTEMPT_MAX,
    );
    expect(
      responses.map((r) => r.status).filter((s) => s === 403),
    ).toHaveLength(VERIFY_STEP_UP_ATTEMPT_MAX);
    const stepUpBudget = `${VERIFY_STEP_UP_ATTEMPT_SCOPE}:${USER_ID}:${await hashAuthToken(token)}`;
    expect(budget.record(stepUpBudget)).toMatchObject({
      count: VERIFY_STEP_UP_ATTEMPT_MAX,
    });
    // The login budget is a different object and stays untouched.
    expect(budget.record(LOGIN_BUDGET)).toBeUndefined();
    expect(errors.calls()).toEqual([]);
  });

  it("lets exactly 10 of 20 concurrent wrong login secrets reach the comparison", async () => {
    await setPin(PIN);
    const errors = captureErrors();
    const ops = watchKvOps(kv);

    const responses = await Promise.all(
      Array.from({ length: BURST }, () => lookup(WRONG_PIN)),
    );

    const codes = await errorCodes(responses);
    expect(count(codes, "VERIFICATION_FAILED")).toBe(VERIFY_ATTEMPT_MAX);
    expect(count(codes, "RATE_LIMITED")).toBe(BURST - VERIFY_ATTEMPT_MAX);
    expect(budget.record(LOGIN_BUDGET)).toMatchObject({
      count: VERIFY_ATTEMPT_MAX,
    });
    // The KV fallback counter is never touched while the object answers.
    expect(ops.getKeys()).not.toContain(await loginCounterKey());
    expect(errors.calls()).toEqual([]);
  });

  it("refuses a correct secret like a wrong one once the window is spent", async () => {
    await setPin(PIN);
    await Promise.all(
      Array.from({ length: VERIFY_ATTEMPT_MAX }, () => lookup(WRONG_PIN)),
    );

    const correct = await lookup(PIN);

    expect(correct.status).toBe(429);
    expect(await correct.json()).toEqual(
      RATE_LIMITED_BODY(VERIFY_ATTEMPT_WINDOW_SECONDS / 2),
    );
  });
});

describe("hourly attempt budgets — a correct secret gives its slot back", () => {
  it("refunds the slot, so the window still holds max wrong guesses after it", async () => {
    await setPin(PIN);
    for (let i = 0; i < 3; i++) {
      expect((await lookup(WRONG_PIN)).status).toBe(403);
    }

    expect((await lookup(PIN)).status).toBe(200);

    expect(budget.record(LOGIN_BUDGET)).toMatchObject({ count: 3 });
    expect(budget.calls.at(-1)).toEqual({
      method: "refund",
      name: LOGIN_BUDGET,
      args: [BUCKET, 0],
    });
    const rest: number[] = [];
    for (let i = 3; i < VERIFY_ATTEMPT_MAX + 1; i++) {
      rest.push((await lookup(WRONG_PIN)).status);
    }
    expect(rest).toEqual([
      ...Array<number>(VERIFY_ATTEMPT_MAX - 3).fill(403),
      429,
    ]);
  });

  it("still admits the correct secret when the refund fails, logging the event name only", async () => {
    await setPin(PIN);
    budget.fail.refund = "error";
    const errors = captureErrors();

    const res = await lookup(PIN);

    expect(res.status).toBe(200);
    expect(errors.calls()).toEqual([["ATTEMPT_BUDGET_REFUND_FAILED"]]);
    expect(errors.text()).not.toContain(USER_ID);
    // The slot stays spent until the window ends.
    expect(budget.record(LOGIN_BUDGET)).toMatchObject({ count: 1 });
  });

  it("logs nothing when the refund empties the window and the object's deleteAlarm fails", async () => {
    await setPin(PIN);
    // A first correct secret creates the object and leaves it with no record.
    expect((await lookup(PIN)).status).toBe(200);
    const storage = budget.storage(LOGIN_BUDGET);
    if (!storage) throw new Error("expected the login budget's object");
    storage.failNextDeleteAlarm = true;
    const errors = captureErrors();

    expect((await lookup(PIN)).status).toBe(200);

    expect(storage.failNextDeleteAlarm).toBe(false);
    expect(errors.calls()).toEqual([]);
    expect(budget.record(LOGIN_BUDGET)).toBeUndefined();
  });
});

describe("hourly attempt budgets — the login and step-up budgets are separate objects", () => {
  it("still compares a step-up secret while the login budget is spent, leaving the login record alone", async () => {
    const token = await setPin(PIN);
    for (let i = 0; i < VERIFY_ATTEMPT_MAX; i++) {
      expect((await lookup(WRONG_PIN)).status).toBe(403);
    }
    expect((await lookup(PIN)).status).toBe(429);
    const loginRecord = budget.record(LOGIN_BUDGET);
    expect(loginRecord).toMatchObject({ count: VERIFY_ATTEMPT_MAX });
    const stepUpBudget = `${VERIFY_STEP_UP_ATTEMPT_SCOPE}:${USER_ID}:${await hashAuthToken(token)}`;

    const wrong = await stepUp(token, WRONG_PIN);
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as Json).error.code).toBe(
      "VERIFICATION_FAILED",
    );
    expect(budget.record(stepUpBudget)).toMatchObject({ count: 1 });

    // DELETE shares the token's step-up budget and, unlike a PUT save, never resets the login one.
    const deleted = await send("DELETE", `/api/user/${USER_ID}`, {
      body: { currentSecret: PIN },
      token,
    });
    expect(deleted.status).toBe(200);
    expect(budget.calls.slice(-2)).toEqual([
      {
        method: "reserve",
        name: stepUpBudget,
        args: [VERIFY_STEP_UP_ATTEMPT_MAX, VERIFY_ATTEMPT_WINDOW_SECONDS],
      },
      { method: "refund", name: stepUpBudget, args: [BUCKET, 0] },
    ]);
    expect(budget.record(stepUpBudget)).toMatchObject({ count: 1 });
    expect(budget.record(LOGIN_BUDGET)).toEqual(loginRecord);
  });
});

describe("hourly attempt budgets — when the object fails", () => {
  it("falls back to the KV counter on a plain error, still admitting the correct secret", async () => {
    await setPin(PIN);
    budget.fail.reserve = "error";
    const errors = captureErrors();

    expect((await lookup(WRONG_PIN)).status).toBe(403);
    expect(await kv.get(await loginCounterKey())).toBe("1");
    expect((await lookup(PIN)).status).toBe(200);

    expect(errors.calls()).toEqual([
      ["ATTEMPT_BUDGET_UNAVAILABLE"],
      ["ATTEMPT_BUDGET_UNAVAILABLE"],
    ]);
    expect(errors.text()).not.toContain(USER_ID);
    expect(budget.calls.map((c) => c.method)).toEqual(["reserve", "reserve"]);
  });

  it("answers 429 RATE_LIMITED with retryAfter 60 when overloaded, comparing and writing nothing", async () => {
    await setPin(PIN);
    budget.fail.reserve = "overloaded";
    const errors = captureErrors();
    const ops = watchKvOps(kv);

    const correct = await lookup(PIN);
    const wrong = await lookup(WRONG_PIN);

    expect(correct.status).toBe(429);
    expect(wrong.status).toBe(429);
    const correctBody = await correct.text();
    expect(correctBody).toBe(await wrong.text());
    expect(JSON.parse(correctBody)).toEqual(RATE_LIMITED_BODY(60));
    expect(correct.headers.get("Retry-After")).toBe("60");
    expect(ops.writeTrail()).toEqual([]);
    expect(ops.getKeys()).not.toContain(await loginCounterKey());
    expect(errors.calls()).toEqual([
      ["ATTEMPT_BUDGET_OVERLOADED"],
      ["ATTEMPT_BUDGET_OVERLOADED"],
    ]);
    expect(errors.text()).not.toContain(USER_ID);
  });

  it("still refuses a spent budget with 429 when the object's alarm check fails, never falling back to KV", async () => {
    await setPin(PIN);
    for (let i = 0; i < VERIFY_ATTEMPT_MAX; i++) {
      expect((await lookup(WRONG_PIN)).status).toBe(403);
    }
    const storage = budget.storage(LOGIN_BUDGET);
    if (!storage) throw new Error("expected the login budget's object");
    storage.failNextGetAlarm = true;
    const errors = captureErrors();
    const ops = watchKvOps(kv);

    const correct = await lookup(PIN);

    expect(correct.status).toBe(429);
    expect(await correct.json()).toEqual(
      RATE_LIMITED_BODY(VERIFY_ATTEMPT_WINDOW_SECONDS / 2),
    );
    expect(storage.failNextGetAlarm).toBe(false);
    expect(errors.calls()).toEqual([]);
    expect(ops.getKeys()).not.toContain(await loginCounterKey());
    expect(ops.writeTrail()).toEqual([]);
  });
});

describe("PUT /api/user/:id/verify — saving empties the login budget", () => {
  async function spendLoginBudget(): Promise<void> {
    for (let i = 0; i < VERIFY_ATTEMPT_MAX; i++) {
      expect((await lookup(WRONG_PIN)).status).toBe(403);
    }
    expect((await lookup(PIN)).status).toBe(429);
  }

  it("resets the object, so the new PIN opens the account at once", async () => {
    const token = await setPin(PIN);
    await spendLoginBudget();

    const saved = await send("PUT", VERIFY_PATH, {
      body: { method: "pin", secret: NEW_PIN, currentSecret: PIN },
      token,
    });

    expect(saved.status).toBe(200);
    expect(budget.calls).toContainEqual({
      method: "reset",
      name: LOGIN_BUDGET,
      args: [VERIFY_ATTEMPT_WINDOW_SECONDS],
    });
    expect(budget.record(LOGIN_BUDGET)).toMatchObject({ count: 0, epoch: 1 });
    expect((await lookup(NEW_PIN)).status).toBe(200);
    expect((await lookup(PIN)).status).toBe(403);
  });

  it("still answers the save when the object reset fails, logging the event name only", async () => {
    const token = await setPin(PIN);
    await spendLoginBudget();
    budget.fail.reset = "error";
    const errors = captureErrors();

    const saved = await send("PUT", VERIFY_PATH, {
      body: { method: "pin", secret: NEW_PIN, currentSecret: PIN },
      token,
    });

    expect(saved.status).toBe(200);
    expect(errors.calls()).toEqual([["VERIFY_CEILING_RESET_FAILED"]]);
    expect(errors.text()).not.toContain(USER_ID);
    // Fail-open: the budget stays spent until its window ends.
    expect((await lookup(NEW_PIN)).status).toBe(429);
  });
});
