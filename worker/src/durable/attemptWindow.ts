// Pure decisions of one hourly attempt budget held by `AttemptBudgetObject`: no imports, no I/O.
// The Durable Object applies the returned record, so every rule here is testable without a runtime.

/** The one record a budget object stores: the window it counts and how many attempts it holds.
 *  `epoch` grows on every reset, so a refund minted before the reset cannot return a newer slot. */
export interface AttemptWindowRecord {
  bucket: number;
  count: number;
  /** Epoch ms at which `bucket` ends. */
  endsAt: number;
  epoch: number;
}

/** Answer of a reservation: the slot's window and epoch (needed to refund it), or the seconds left. */
export type AttemptReserveResult =
  | { admitted: true; bucket: number; epoch: number }
  | { admitted: false; retryAfter: number };

/** Index of the fixed, clock-aligned window `now` falls in, and when that window ends. */
function windowAt(
  now: number,
  windowSec: number,
): { bucket: number; endsAt: number } {
  const windowMs = windowSec * 1000;
  const bucket = Math.floor(now / windowMs);
  return { bucket, endsAt: (bucket + 1) * windowMs };
}

/**
 * Reserve one attempt in the current window. A stored record from an earlier
 * window counts as empty but keeps its `epoch`. A full window is refused with
 * `retryAfter` = the whole seconds left (at least 1) and nothing to write
 * (`next: null`); otherwise `next` is the record with one more attempt.
 */
export function decideReserve(
  stored: AttemptWindowRecord | undefined,
  now: number,
  max: number,
  windowSec: number,
): { result: AttemptReserveResult; next: AttemptWindowRecord | null } {
  const { bucket, endsAt } = windowAt(now, windowSec);
  const epoch = stored?.epoch ?? 0;
  const count = stored?.bucket === bucket ? stored.count : 0;

  if (count >= max) {
    const retryAfter = Math.max(1, Math.ceil((endsAt - now) / 1000));
    return { result: { admitted: false, retryAfter }, next: null };
  }

  return {
    result: { admitted: true, bucket, epoch },
    next: { bucket, count: count + 1, endsAt, epoch },
  };
}

/**
 * Give back one attempt reserved in `bucket` under `epoch`. Anything that does
 * not match the stored record exactly — no record, another window, a reset in
 * between, nothing left to return — changes nothing. The record is deleted
 * only when it would drop to zero at epoch 0; a later epoch must survive.
 */
export function decideRefund(
  stored: AttemptWindowRecord | undefined,
  bucket: number,
  epoch: number,
): { next: AttemptWindowRecord | null; delete: boolean } {
  if (!stored || stored.bucket !== bucket || stored.epoch !== epoch) {
    return { next: null, delete: false };
  }
  if (stored.count <= 0) return { next: null, delete: false };

  const count = stored.count - 1;
  if (count === 0 && stored.epoch === 0) return { next: null, delete: true };
  return { next: { ...stored, count }, delete: false };
}

/**
 * Empty the current window and move to a new epoch, so a refund of a slot
 * reserved before the reset is ignored. No record, or a record from an earlier
 * window, needs nothing: `null` (nothing to write).
 */
export function decideReset(
  stored: AttemptWindowRecord | undefined,
  now: number,
  windowSec: number,
): AttemptWindowRecord | null {
  const { bucket, endsAt } = windowAt(now, windowSec);
  if (!stored || stored.bucket !== bucket) return null;
  return { bucket, count: 0, endsAt, epoch: stored.epoch + 1 };
}
