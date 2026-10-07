/** "Own leave / delete-account request in flight" mark (#263): blocks the silent recovery join
 *  meanwhile. See docs/architecture.md → 背景自動復原的防護. */

import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";

/** Epoch ms until which this user's own departure counts as in flight. */
export const SELF_DEPARTURE_UNTIL_KEY = "moo:selfDepartureUntil";

/** Backstop lifetime of the mark (60 s) when its cleanup never runs. */
export const SELF_DEPARTURE_TTL_MS = 60_000;

/** The code every Worker 401 carries; it is answered before any handler work. */
const UNAUTHORIZED_CODE = "UNAUTHORIZED";

/**
 * SENDS the user's own leave / delete-account request with the departure mark
 * WRITTEN, then hands the response to `settle` while the mark still guards.
 * The mark is removed when everything settles — success, error or throw.
 *
 * If the guarded send comes back `UNAUTHORIZED` (this device's token was
 * replaced elsewhere, and the mark blocked the recovery join), the mark is
 * ended and the request is resent ONCE, so the client's normal 401 → recovery
 * join → resend path runs; whatever that returns is settled like any other
 * response. Safe: a 401 means the server never processed the departure, so a
 * recovery join has nothing to undo yet, and once the departure lands an
 * updated server refuses a recovery join from a user who is no longer listed
 * (`recovery: 1` → 409 RECOVERY_NOT_MEMBER). Mirrors
 * `extension/src/storage/selfDeparture.ts`.
 */
export async function runGuardedDeparture<T>(
  send: () => Promise<ApiResponse<T>>,
  settle: (res: ApiResponse<T>) => void,
): Promise<void> {
  let endSelfDeparture = beginSelfDeparture();
  try {
    let res = await send();
    if (res.error?.code === UNAUTHORIZED_CODE) {
      endSelfDeparture();
      res = await send();
      // Re-arm for `settle`, which clears local state the recovery join reads.
      endSelfDeparture = beginSelfDeparture();
    }
    settle(res);
  } finally {
    endSelfDeparture();
  }
}

/**
 * WRITES the mark and returns the function that removes it. Call the returned
 * function in a `finally` so success, error and throw all clear it.
 *
 * The cleanup only removes the value this call wrote: a mark written later by
 * another tab's departure must keep guarding until that tab clears it.
 */
export function beginSelfDeparture(): () => void {
  const until = String(Date.now() + SELF_DEPARTURE_TTL_MS);
  try {
    localStorage.setItem(SELF_DEPARTURE_UNTIL_KEY, until);
  } catch {
    // Best-effort: a refused write costs the guard, never the leave.
  }
  return () => {
    try {
      if (localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY) === until) {
        localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
      }
    } catch {
      // Best-effort; the expiry retires the mark on its own.
    }
  };
}

/**
 * True while a departure mark is live. A deadline further ahead than the TTL
 * was written under a clock that has since moved back, so it is ignored rather
 * than allowed to block recovery for longer than the backstop.
 */
export function isSelfDepartureActive(): boolean {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  const remaining = Number(raw) - Date.now();
  return remaining > 0 && remaining <= SELF_DEPARTURE_TTL_MS;
}
