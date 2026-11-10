import { describe, it, expect } from "vitest";
import {
  decideRefund,
  decideReserve,
  decideReset,
  type AttemptWindowRecord,
} from "../../src/durable/attemptWindow";

/**
 * The pure decisions behind one hourly attempt budget (`src/durable/attemptWindow.ts`).
 *
 * Windows are fixed and clock-aligned: bucket = floor(now / window), ending at
 * (bucket + 1) × window. A reservation counts one attempt in the current window
 * or is refused with the whole seconds left (at least 1). A refund gives one
 * back only to the exact window and epoch it was reserved under. A reset empties
 * the current window and moves to a new epoch, so a refund minted before it is
 * ignored; a record from an earlier window needs no reset. Times are built from
 * a window-aligned base so every bucket and `endsAt` below is exact.
 */

const WINDOW_SEC = 3600;
const WINDOW_MS = WINDOW_SEC * 1000;
const MAX = 3;
const BUCKET = 490_000;
const START = BUCKET * WINDOW_MS;
const ENDS_AT = START + WINDOW_MS;
const MID = START + WINDOW_MS / 2;

function record(
  overrides: Partial<AttemptWindowRecord> = {},
): AttemptWindowRecord {
  return { bucket: BUCKET, count: 1, endsAt: ENDS_AT, epoch: 0, ...overrides };
}

describe("decideReserve", () => {
  it("admits the first attempt with no record, at epoch 0", () => {
    expect(decideReserve(undefined, MID, MAX, WINDOW_SEC)).toEqual({
      result: { admitted: true, bucket: BUCKET, epoch: 0 },
      next: { bucket: BUCKET, count: 1, endsAt: ENDS_AT, epoch: 0 },
    });
  });

  it("accumulates in the same window and keeps the stored epoch", () => {
    expect(
      decideReserve(record({ count: 2, epoch: 4 }), MID, MAX, WINDOW_SEC),
    ).toEqual({
      result: { admitted: true, bucket: BUCKET, epoch: 4 },
      next: { bucket: BUCKET, count: 3, endsAt: ENDS_AT, epoch: 4 },
    });
  });

  it.each([
    { label: "mid-window", now: MID, retryAfter: WINDOW_SEC / 2 },
    { label: "at the window start", now: START, retryAfter: WINDOW_SEC },
    { label: "1.5 s before the end", now: ENDS_AT - 1500, retryAfter: 2 },
    { label: "1 ms before the end", now: ENDS_AT - 1, retryAfter: 1 },
  ])(
    "refuses at max $label with the whole seconds left, writing nothing",
    ({ now, retryAfter }) => {
      expect(
        decideReserve(record({ count: MAX }), now, MAX, WINDOW_SEC),
      ).toEqual({ result: { admitted: false, retryAfter }, next: null });
    },
  );

  it("refuses a record already past max", () => {
    expect(
      decideReserve(record({ count: MAX + 2 }), MID, MAX, WINDOW_SEC).result,
    ).toEqual({ admitted: false, retryAfter: WINDOW_SEC / 2 });
  });

  it("counts a full record from an earlier window as empty, keeping its epoch", () => {
    const now = ENDS_AT + 10_000;
    expect(
      decideReserve(record({ count: MAX, epoch: 2 }), now, MAX, WINDOW_SEC),
    ).toEqual({
      result: { admitted: true, bucket: BUCKET + 1, epoch: 2 },
      next: {
        bucket: BUCKET + 1,
        count: 1,
        endsAt: ENDS_AT + WINDOW_MS,
        epoch: 2,
      },
    });
  });

  it("derives the window from windowSec", () => {
    const now = 125_000;
    expect(decideReserve(undefined, now, MAX, 60).next).toEqual({
      bucket: 2,
      count: 1,
      endsAt: 180_000,
      epoch: 0,
    });
  });
});

describe("decideRefund", () => {
  it("gives one back to the window and epoch it was reserved under", () => {
    expect(decideRefund(record({ count: 3, epoch: 1 }), BUCKET, 1)).toEqual({
      next: record({ count: 2, epoch: 1 }),
      delete: false,
    });
  });

  it.each([
    { label: "no record", stored: undefined, bucket: BUCKET, epoch: 0 },
    {
      label: "another window",
      stored: record({ count: 2 }),
      bucket: BUCKET - 1,
      epoch: 0,
    },
    {
      label: "another epoch (a reset in between)",
      stored: record({ count: 2, epoch: 1 }),
      bucket: BUCKET,
      epoch: 0,
    },
    {
      label: "a count of zero",
      stored: record({ count: 0, epoch: 1 }),
      bucket: BUCKET,
      epoch: 1,
    },
    {
      label: "a negative count",
      stored: record({ count: -1 }),
      bucket: BUCKET,
      epoch: 0,
    },
  ])("changes nothing for $label", ({ stored, bucket, epoch }) => {
    expect(decideRefund(stored, bucket, epoch)).toEqual({
      next: null,
      delete: false,
    });
  });

  it("deletes the record when it drops to zero at epoch 0", () => {
    expect(decideRefund(record({ count: 1 }), BUCKET, 0)).toEqual({
      next: null,
      delete: true,
    });
  });

  it("keeps a record that drops to zero at a later epoch, so the epoch survives", () => {
    expect(decideRefund(record({ count: 1, epoch: 3 }), BUCKET, 3)).toEqual({
      next: record({ count: 0, epoch: 3 }),
      delete: false,
    });
  });
});

describe("decideReset", () => {
  it("returns null when there is no record", () => {
    expect(decideReset(undefined, MID, WINDOW_SEC)).toBeNull();
  });

  it("returns null for a record from an earlier window", () => {
    expect(decideReset(record({ count: MAX }), ENDS_AT, WINDOW_SEC)).toBeNull();
  });

  it("empties the current window and moves to the next epoch", () => {
    expect(
      decideReset(record({ count: MAX, epoch: 2 }), MID, WINDOW_SEC),
    ).toEqual({ bucket: BUCKET, count: 0, endsAt: ENDS_AT, epoch: 3 });
  });

  it("makes a refund minted before the reset change nothing", () => {
    const reset = decideReset(record({ count: MAX }), MID, WINDOW_SEC);
    const refilled = { ...reset!, count: 2 };

    expect(decideRefund(refilled, BUCKET, 0)).toEqual({
      next: null,
      delete: false,
    });
  });
});
