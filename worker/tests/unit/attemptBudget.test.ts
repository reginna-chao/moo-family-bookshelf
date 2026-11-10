import { inspect } from "node:util";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ATTEMPT_BUDGET_OVERLOAD_RETRY_SECONDS,
  releaseCorrectGuess,
  reserveAttempt,
  resetAttemptBudget,
  settleWrongGuess,
  type AttemptReservation,
} from "../../src/services/attemptBudget";
import { peekPerUserRateLimit } from "../../src/middleware/rateLimit";
import type { Env } from "../../src/utils/env";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { ALICE } from "../helpers/ids";
import {
  createAttemptBudgetNamespace,
  type AttemptBudgetNamespaceFake,
} from "../helpers/attemptBudgetNamespace";

/**
 * `services/attemptBudget.ts`, the only module that touches `env.ATTEMPT_BUDGET`.
 *
 * Paths of `reserveAttempt`: DEV_MODE ⇒ `off` (no RPC, no log); no binding ⇒ the
 * KV fallback counter with `ATTEMPT_BUDGET_BINDING_MISSING`; an admitted
 * reservation ⇒ `durable`; a refused one ⇒ `limited` with the object's
 * `retryAfter`; an `overloaded` error ⇒ `limited` 60 with
 * `ATTEMPT_BUDGET_OVERLOADED` and no KV access; any other error ⇒ the KV
 * fallback with `ATTEMPT_BUDGET_UNAVAILABLE`. `settleWrongGuess` writes the KV
 * counter only for a `kv` reservation; `releaseCorrectGuess` refunds only a
 * `durable` one and swallows a failed refund (`ATTEMPT_BUDGET_REFUND_FAILED`).
 * `resetAttemptBudget` always deletes the KV window key and, with the binding
 * outside DEV_MODE, resets the object; either leg failing throws a generic error
 * after both have settled.
 *
 * Logs carry the event name only: every injected error's message names the
 * object (and so the userId), and each log assertion checks it never shows.
 * The clock is pinned mid-window (`Date` only), so `retryAfter` is exact.
 */

const SUBJECT = ALICE;
const SCOPE = "verify";
const MAX = 3;
const WINDOW_SEC = 3600;
const WINDOW_MS = WINDOW_SEC * 1000;
const BUCKET = 490_000;
const PINNED_NOW = BUCKET * WINDOW_MS + WINDOW_MS / 2;
const OPTS = {
  subject: SUBJECT,
  scope: SCOPE,
  max: MAX,
  windowSec: WINDOW_SEC,
};
const OBJECT_NAME = `${SCOPE}:${SUBJECT}`;

let kv: KVNamespace;
let fake: AttemptBudgetNamespaceFake;
let errorLog: ReturnType<typeof vi.spyOn>;

const withBinding = (): Env => ({ KV: kv, ATTEMPT_BUDGET: fake.namespace });
const withoutBinding = (): Env => ({ KV: kv });
const devMode = (): Env => ({ ...withBinding(), DEV_MODE: "1" });

/** The KV fallback counter key of the current window, via the production builder. */
async function counterKey(): Promise<string> {
  const { key } = await peekPerUserRateLimit(kv, {
    userId: SUBJECT,
    scope: SCOPE,
    max: MAX,
    windowSec: WINDOW_SEC,
  });
  return key;
}

function loggedText(): string {
  return inspect(errorLog.mock.calls, { depth: 6 });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  kv = createMockKV();
  fake = createAttemptBudgetNamespace();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reserveAttempt", () => {
  it("is off under DEV_MODE: no RPC, no KV read, no log", async () => {
    const ops = watchKvOps(kv);

    expect(await reserveAttempt(devMode(), OPTS)).toEqual({ kind: "off" });
    expect(fake.calls).toEqual([]);
    expect(ops.getKeys()).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("reads the KV counter and logs the missing binding when there is none", async () => {
    const reservation = await reserveAttempt(withoutBinding(), OPTS);

    expect(reservation).toEqual({
      kind: "kv",
      reading: {
        verdict: { limited: false },
        key: await counterKey(),
        count: 0,
        windowSec: WINDOW_SEC,
      },
    });
    expect(errorLog.mock.calls).toEqual([["ATTEMPT_BUDGET_BINDING_MISSING"]]);
  });

  it("refuses on the KV fallback once the counter is full", async () => {
    await kv.put(await counterKey(), String(MAX));

    expect(await reserveAttempt(withoutBinding(), OPTS)).toEqual({
      kind: "limited",
      retryAfter: WINDOW_SEC / 2,
    });
  });

  it("reserves on the object named `${scope}:${subject}` and touches no KV", async () => {
    const ops = watchKvOps(kv);

    const reservation = await reserveAttempt(withBinding(), OPTS);

    expect(reservation).toEqual({
      kind: "durable",
      scope: SCOPE,
      subject: SUBJECT,
      bucket: BUCKET,
      epoch: 0,
    });
    expect(fake.calls).toEqual([
      { method: "reserve", name: OBJECT_NAME, args: [MAX, WINDOW_SEC] },
    ]);
    expect(ops.getKeys()).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("answers limited with the object's retryAfter once the window is spent", async () => {
    for (let i = 0; i < MAX; i++) await reserveAttempt(withBinding(), OPTS);

    expect(await reserveAttempt(withBinding(), OPTS)).toEqual({
      kind: "limited",
      retryAfter: WINDOW_SEC / 2,
    });
  });

  it("answers limited 60 on an overloaded object, without falling back to KV", async () => {
    fake.fail.reserve = "overloaded";
    const ops = watchKvOps(kv);

    expect(await reserveAttempt(withBinding(), OPTS)).toEqual({
      kind: "limited",
      retryAfter: ATTEMPT_BUDGET_OVERLOAD_RETRY_SECONDS,
    });
    expect(ATTEMPT_BUDGET_OVERLOAD_RETRY_SECONDS).toBe(60);
    expect(ops.getKeys()).toEqual([]);
    expect(errorLog.mock.calls).toEqual([["ATTEMPT_BUDGET_OVERLOADED"]]);
    expect(loggedText()).not.toContain(SUBJECT);
  });

  it("falls back to the KV counter on any other object error", async () => {
    fake.fail.reserve = "error";

    const reservation = await reserveAttempt(withBinding(), OPTS);

    expect(reservation).toMatchObject({
      kind: "kv",
      reading: { key: await counterKey(), count: 0 },
    });
    expect(errorLog.mock.calls).toEqual([["ATTEMPT_BUDGET_UNAVAILABLE"]]);
    expect(loggedText()).not.toContain(SUBJECT);
  });

  it("refuses on the fallback after an object error when the KV counter is full", async () => {
    fake.fail.reserve = "error";
    await kv.put(await counterKey(), String(MAX));

    expect(await reserveAttempt(withBinding(), OPTS)).toEqual({
      kind: "limited",
      retryAfter: WINDOW_SEC / 2,
    });
  });

  it("treats a thrown non-object as a plain error", async () => {
    const throwing = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        reserve: () => Promise.reject("not an object"),
      }),
    } as unknown as NonNullable<Env["ATTEMPT_BUDGET"]>;

    const reservation = await reserveAttempt(
      { KV: kv, ATTEMPT_BUDGET: throwing },
      OPTS,
    );

    expect(reservation.kind).toBe("kv");
    expect(errorLog.mock.calls).toEqual([["ATTEMPT_BUDGET_UNAVAILABLE"]]);
  });
});

describe("settleWrongGuess", () => {
  it("charges the KV counter for a kv reservation", async () => {
    const reservation = await reserveAttempt(withoutBinding(), OPTS);

    await settleWrongGuess(withoutBinding(), reservation);

    expect(await kv.get(await counterKey())).toBe("1");
  });

  it.each<{ label: string; reservation: AttemptReservation }>([
    { label: "off", reservation: { kind: "off" } },
    { label: "limited", reservation: { kind: "limited", retryAfter: 5 } },
    {
      label: "durable",
      reservation: {
        kind: "durable",
        scope: SCOPE,
        subject: SUBJECT,
        bucket: BUCKET,
        epoch: 0,
      },
    },
  ])("writes nothing and calls nothing for $label", async ({ reservation }) => {
    const ops = watchKvOps(kv);

    await settleWrongGuess(withBinding(), reservation);

    expect(ops.writeTrail()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("releaseCorrectGuess", () => {
  it("refunds a durable reservation with its bucket and epoch", async () => {
    const reservation = await reserveAttempt(withBinding(), OPTS);

    await releaseCorrectGuess(withBinding(), reservation);

    expect(fake.calls.at(-1)).toEqual({
      method: "refund",
      name: OBJECT_NAME,
      args: [BUCKET, 0],
    });
    expect(fake.record(OBJECT_NAME)).toBeUndefined();
  });

  it.each<{ label: string; reservation: AttemptReservation }>([
    { label: "off", reservation: { kind: "off" } },
    { label: "limited", reservation: { kind: "limited", retryAfter: 5 } },
  ])("calls nothing for $label", async ({ reservation }) => {
    await releaseCorrectGuess(withBinding(), reservation);

    expect(fake.calls).toEqual([]);
  });

  it("calls nothing and writes no KV for a kv reservation", async () => {
    const reservation = await reserveAttempt(withoutBinding(), OPTS);
    const ops = watchKvOps(kv);

    await releaseCorrectGuess(withBinding(), reservation);

    expect(fake.calls).toEqual([]);
    expect(ops.writeTrail()).toEqual([]);
  });

  it("does nothing for a durable reservation when the binding is gone", async () => {
    const reservation = await reserveAttempt(withBinding(), OPTS);

    await releaseCorrectGuess(withoutBinding(), reservation);

    expect(fake.calls.map((c) => c.method)).toEqual(["reserve"]);
  });

  it("swallows a failed refund, logging the event name only, the slot staying spent", async () => {
    const reservation = await reserveAttempt(withBinding(), OPTS);
    fake.fail.refund = "error";

    await expect(
      releaseCorrectGuess(withBinding(), reservation),
    ).resolves.toBeUndefined();

    expect(errorLog.mock.calls).toEqual([["ATTEMPT_BUDGET_REFUND_FAILED"]]);
    expect(loggedText()).not.toContain(SUBJECT);
    expect(fake.record(OBJECT_NAME)).toMatchObject({ count: 1 });
  });
});

describe("resetAttemptBudget", () => {
  const RESET_OPTS = { subject: SUBJECT, scope: SCOPE, windowSec: WINDOW_SEC };

  it("deletes the KV window key and resets the object, logging nothing", async () => {
    await kv.put(await counterKey(), "2");
    await reserveAttempt(withBinding(), OPTS);
    await reserveAttempt(withBinding(), OPTS);

    await resetAttemptBudget(withBinding(), RESET_OPTS);

    expect(await kv.get(await counterKey())).toBeNull();
    expect(fake.calls.at(-1)).toEqual({
      method: "reset",
      name: OBJECT_NAME,
      args: [WINDOW_SEC],
    });
    expect(fake.record(OBJECT_NAME)).toMatchObject({ count: 0, epoch: 1 });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each([
    { label: "under DEV_MODE", env: devMode },
    { label: "with no binding", env: withoutBinding },
  ])(
    "deletes the KV window key without an RPC or a log $label",
    async ({ env }) => {
      await kv.put(await counterKey(), "2");

      await resetAttemptBudget(env(), RESET_OPTS);

      expect(await kv.get(await counterKey())).toBeNull();
      expect(fake.calls).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it("throws a generic error when the object reset fails, the KV delete still done", async () => {
    await kv.put(await counterKey(), "2");
    fake.fail.reset = "error";

    const err = await resetAttemptBudget(withBinding(), RESET_OPTS).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("ATTEMPT_BUDGET_RESET_FAILED");
    expect(await kv.get(await counterKey())).toBeNull();
  });

  it("throws a generic error when the KV delete fails, after the object reset landed", async () => {
    await reserveAttempt(withBinding(), OPTS);
    const key = await counterKey();
    vi.spyOn(kv, "delete").mockRejectedValue(new Error(`delete ${key}`));

    const err = await resetAttemptBudget(withBinding(), RESET_OPTS).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toBe("ATTEMPT_BUDGET_RESET_FAILED");
    expect((err as Error).message).not.toContain(SUBJECT);
    expect(fake.record(OBJECT_NAME)).toMatchObject({ count: 0, epoch: 1 });
  });
});
