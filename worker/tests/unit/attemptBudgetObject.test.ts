import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AttemptBudgetObject } from "../../src/durable/attemptBudgetObject";
import {
  createAttemptBudgetObject,
  type FakeDurableStorage,
} from "../helpers/attemptBudgetNamespace";

/**
 * `AttemptBudgetObject`, the Durable Object behind one hourly attempt budget,
 * driven through a fake `ctx.storage` (`tests/helpers/attemptBudgetNamespace.ts`):
 * a synchronous `kv` map holding the single `"window"` record, and alarm
 * recorders.
 *
 * Alarm contract: every call that leaves a record (an admitted reserve, a
 * refused one, a reset that wrote) checks `getAlarm()` and arms one at the
 * window's end only when none is set, so a `setAlarm` that failed is repaired
 * by the next call. A failed `getAlarm` / `setAlarm` never rejects the call: it
 * still returns its decided result (an admission, or a refusal with nothing
 * written), because a rejected RPC would send the request to the KV fallback,
 * where a refused attempt could be admitted. A refund that deletes the record
 * also deletes the alarm.
 * `alarm()` deletes a finished window's record (its epoch with it) and re-arms
 * for an unfinished one.
 *
 * The clock is faked (`Date` only) and pinned mid-window; restored in `afterEach`.
 */

const WINDOW_SEC = 3600;
const WINDOW_MS = WINDOW_SEC * 1000;
const MAX = 2;
const BUCKET = 490_000;
const START = BUCKET * WINDOW_MS;
const ENDS_AT = START + WINDOW_MS;
const MID = START + WINDOW_MS / 2;
const KEY = "window";

let object: AttemptBudgetObject;
let storage: FakeDurableStorage;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MID);
  ({ object, storage } = createAttemptBudgetObject());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AttemptBudgetObject.reserve", () => {
  it("admits up to max, then refuses with the seconds left, storing the count", async () => {
    const results = [
      await object.reserve(MAX, WINDOW_SEC),
      await object.reserve(MAX, WINDOW_SEC),
      await object.reserve(MAX, WINDOW_SEC),
    ];

    expect(results).toEqual([
      { admitted: true, bucket: BUCKET, epoch: 0 },
      { admitted: true, bucket: BUCKET, epoch: 0 },
      { admitted: false, retryAfter: WINDOW_SEC / 2 },
    ]);
    expect(storage.kv.get(KEY)).toEqual({
      bucket: BUCKET,
      count: MAX,
      endsAt: ENDS_AT,
      epoch: 0,
    });
  });

  it("admits exactly max of many concurrent reservations", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => object.reserve(MAX, WINDOW_SEC)),
    );

    expect(results.filter((r) => r.admitted)).toHaveLength(MAX);
    expect(storage.kv.get(KEY)).toMatchObject({ count: MAX });
  });

  it("arms an alarm at the window's end on the first reservation only", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    await object.reserve(MAX, WINDOW_SEC);

    expect(storage.alarm).toBe(ENDS_AT);
    expect(storage.alarmCalls).toEqual(["get", `set:${ENDS_AT}`, "get"]);
  });

  it("re-arms a missing alarm on a refused reservation too", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    await object.reserve(MAX, WINDOW_SEC);
    storage.alarm = null;
    storage.alarmCalls.length = 0;

    const refused = await object.reserve(MAX, WINDOW_SEC);

    expect(refused.admitted).toBe(false);
    expect(storage.alarm).toBe(ENDS_AT);
    expect(storage.alarmCalls).toEqual(["get", `set:${ENDS_AT}`]);
  });

  it("repairs a failed setAlarm on the next call, the count already stored", async () => {
    storage.failNextSetAlarm = true;

    await expect(object.reserve(MAX, WINDOW_SEC)).resolves.toEqual({
      admitted: true,
      bucket: BUCKET,
      epoch: 0,
    });
    expect(storage.failNextSetAlarm).toBe(false);
    expect(storage.kv.get(KEY)).toMatchObject({ count: 1 });
    expect(storage.alarm).toBeNull();

    await object.reserve(MAX, WINDOW_SEC);
    expect(storage.alarm).toBe(ENDS_AT);
  });

  it.each([
    { label: "getAlarm", flag: "failNextGetAlarm", calls: ["get"] },
    {
      label: "setAlarm",
      flag: "failNextSetAlarm",
      calls: ["get", `set:${ENDS_AT}`],
    },
  ] as const)(
    "still refuses a full budget when $label fails, writing nothing",
    async ({ flag, calls }) => {
      await object.reserve(MAX, WINDOW_SEC);
      await object.reserve(MAX, WINDOW_SEC);
      const before = storage.kv.get(KEY);
      // With no alarm set, the refused call reaches setAlarm too.
      storage.alarm = null;
      storage.alarmCalls.length = 0;
      storage[flag] = true;

      await expect(object.reserve(MAX, WINDOW_SEC)).resolves.toEqual({
        admitted: false,
        retryAfter: WINDOW_SEC / 2,
      });
      expect(storage[flag]).toBe(false);
      expect(storage.alarmCalls).toEqual(calls);
      expect(storage.kv.get(KEY)).toEqual(before);
      expect(storage.alarm).toBeNull();
    },
  );

  it("starts a new window's count once the clock passes the end", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    await object.reserve(MAX, WINDOW_SEC);
    vi.setSystemTime(ENDS_AT + 1000);

    expect(await object.reserve(MAX, WINDOW_SEC)).toEqual({
      admitted: true,
      bucket: BUCKET + 1,
      epoch: 0,
    });
    expect(storage.kv.get(KEY)).toMatchObject({ bucket: BUCKET + 1, count: 1 });
  });
});

describe("AttemptBudgetObject.refund", () => {
  it("gives back a slot, so the next reservation is admitted again", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    const second = await object.reserve(MAX, WINDOW_SEC);
    if (!second.admitted) throw new Error("expected an admitted reservation");

    await object.refund(second.bucket, second.epoch);

    expect(storage.kv.get(KEY)).toMatchObject({ count: 1 });
    expect((await object.reserve(MAX, WINDOW_SEC)).admitted).toBe(true);
  });

  it("deletes the record and its alarm when the count returns to zero at epoch 0", async () => {
    const slot = await object.reserve(MAX, WINDOW_SEC);
    if (!slot.admitted) throw new Error("expected an admitted reservation");

    await object.refund(slot.bucket, slot.epoch);

    expect(storage.kv.has(KEY)).toBe(false);
    expect(storage.alarm).toBeNull();
    expect(storage.alarmCalls.at(-1)).toBe("delete");
  });

  it.each([
    { label: "another window", bucket: BUCKET - 1, epoch: 0 },
    { label: "another epoch", bucket: BUCKET, epoch: 1 },
  ])("changes nothing for a slot of $label", async ({ bucket, epoch }) => {
    await object.reserve(MAX, WINDOW_SEC);
    const before = storage.kv.get(KEY);
    const alarmCalls = storage.alarmCalls.length;

    await object.refund(bucket, epoch);

    expect(storage.kv.get(KEY)).toEqual(before);
    expect(storage.alarmCalls).toHaveLength(alarmCalls);
  });

  it("changes nothing on an object that holds no record", async () => {
    await object.refund(BUCKET, 0);

    expect(storage.kv.size).toBe(0);
    expect(storage.alarmCalls).toEqual([]);
  });
});

describe("AttemptBudgetObject.reset", () => {
  it("empties the current window and starts a new epoch, so an older refund is ignored", async () => {
    const old = await object.reserve(MAX, WINDOW_SEC);
    if (!old.admitted) throw new Error("expected an admitted reservation");
    await object.reserve(MAX, WINDOW_SEC);

    await object.reset(WINDOW_SEC);
    expect(storage.kv.get(KEY)).toEqual({
      bucket: BUCKET,
      count: 0,
      endsAt: ENDS_AT,
      epoch: 1,
    });

    const after = [
      await object.reserve(MAX, WINDOW_SEC),
      await object.reserve(MAX, WINDOW_SEC),
    ];
    expect(after).toEqual([
      { admitted: true, bucket: BUCKET, epoch: 1 },
      { admitted: true, bucket: BUCKET, epoch: 1 },
    ]);
    await object.refund(old.bucket, old.epoch);
    expect((await object.reserve(MAX, WINDOW_SEC)).admitted).toBe(false);
  });

  it("writes nothing and touches no alarm on an object with no record", async () => {
    await object.reset(WINDOW_SEC);

    expect(storage.kv.size).toBe(0);
    expect(storage.alarmCalls).toEqual([]);
  });

  it("writes nothing for a record from an earlier window", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    const before = storage.kv.get(KEY);
    vi.setSystemTime(ENDS_AT + 1000);

    await object.reset(WINDOW_SEC);

    expect(storage.kv.get(KEY)).toEqual(before);
  });

  it("re-arms a missing alarm when it writes, and leaves an existing one alone", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    storage.alarm = null;
    storage.alarmCalls.length = 0;

    await object.reset(WINDOW_SEC);
    expect(storage.alarmCalls).toEqual(["get", `set:${ENDS_AT}`]);

    storage.alarmCalls.length = 0;
    await object.reserve(MAX, WINDOW_SEC);
    await object.reset(WINDOW_SEC);
    expect(storage.alarmCalls).toEqual(["get", "get"]);
  });

  it.each(["failNextGetAlarm", "failNextSetAlarm"] as const)(
    "still resolves with the new epoch stored when the alarm check fails (%s)",
    async (flag) => {
      await object.reserve(MAX, WINDOW_SEC);
      storage.alarm = null;
      storage[flag] = true;

      await expect(object.reset(WINDOW_SEC)).resolves.toBeUndefined();

      expect(storage[flag]).toBe(false);
      expect(storage.kv.get(KEY)).toEqual({
        bucket: BUCKET,
        count: 0,
        endsAt: ENDS_AT,
        epoch: 1,
      });
      expect(storage.alarm).toBeNull();
    },
  );
});

describe("AttemptBudgetObject.alarm", () => {
  it("deletes a finished window's record", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    await object.reset(WINDOW_SEC);
    vi.setSystemTime(ENDS_AT);

    await object.alarm();

    expect(storage.kv.has(KEY)).toBe(false);
    // The epoch went with the record: the next window starts again at 0.
    expect(await object.reserve(MAX, WINDOW_SEC)).toMatchObject({ epoch: 0 });
  });

  it("re-arms for a window that has not finished, keeping the record", async () => {
    await object.reserve(MAX, WINDOW_SEC);
    storage.alarm = null;
    storage.alarmCalls.length = 0;

    await object.alarm();

    expect(storage.kv.get(KEY)).toMatchObject({ count: 1 });
    expect(storage.alarm).toBe(ENDS_AT);
    expect(storage.alarmCalls).toEqual([`set:${ENDS_AT}`]);
  });

  it("does nothing harmful on an object with no record", async () => {
    await object.alarm();

    expect(storage.kv.size).toBe(0);
    expect(storage.alarmCalls).toEqual([]);
  });
});
