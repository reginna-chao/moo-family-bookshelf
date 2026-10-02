/**
 * "This user's own leave / delete-account request is in flight" mark (#263).
 *
 * The server can revoke the user's token before it answers their own "leave
 * family" or "delete account" request, so another request of theirs may 401
 * meanwhile — and the silent recovery join (`attemptJoinRecovery` in
 * `api/auth-refresh.ts`) would then re-add them to the family they are
 * leaving, because the local family id is only cleared after the response.
 * `dialog/useFamilySettingsLeave.ts` / `useFamilySettingsDelete.ts` send through
 * `runGuardedDeparture`, which holds the mark until the request settles;
 * `doRefreshToken` skips the join while it is active. Mirrors
 * `pwa/src/utils/selfDeparture.ts`.
 *
 * Read and written directly in `browser.storage.local` — never through a
 * background message, which Firefox's sleeping event page can drop — so every
 * context of the extension (each tab's dialog included) sees it. The value is
 * an expiry (epoch ms), not a flag: a context that dies mid-request blocks
 * recovery for at most `SELF_DEPARTURE_TTL_MS`.
 *
 * Failures are swallowed in the direction that keeps the user unblocked: a
 * refused write costs the guard, never the leave itself, and an unreadable
 * store reads as "not departing" so recovery keeps working.
 */

import browser from "webextension-polyfill";
import type { ApiResponse } from "../api/types";
import { SELF_DEPARTURE_UNTIL_KEY } from "../constants";

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
 * `pwa/src/utils/selfDeparture.ts`.
 */
export async function runGuardedDeparture<T>(
  send: () => Promise<ApiResponse<T>>,
  settle: (res: ApiResponse<T>) => void | Promise<void>,
): Promise<void> {
  let endSelfDeparture = await beginSelfDeparture();
  try {
    let res = await send();
    if (res.error?.code === UNAUTHORIZED_CODE) {
      await endSelfDeparture();
      res = await send();
      // Re-arm for `settle`, which clears local state the recovery join reads.
      endSelfDeparture = await beginSelfDeparture();
    }
    await settle(res);
  } finally {
    await endSelfDeparture();
  }
}

/**
 * WRITES the mark and resolves to the function that removes it. Await the
 * returned function in a `finally` so success, error and throw all clear it.
 *
 * The cleanup only removes the value this call wrote: a mark written later by
 * another tab's departure must keep guarding until that tab clears it. After
 * an account deletion has already cleared storage it simply finds nothing.
 */
export async function beginSelfDeparture(): Promise<() => Promise<void>> {
  const until = Date.now() + SELF_DEPARTURE_TTL_MS;
  try {
    await browser.storage.local.set({ [SELF_DEPARTURE_UNTIL_KEY]: until });
  } catch (err) {
    console.warn("[selfDeparture] Failed to record departure mark", err);
  }
  return async () => {
    try {
      const stored = await browser.storage.local.get(SELF_DEPARTURE_UNTIL_KEY);
      if (stored[SELF_DEPARTURE_UNTIL_KEY] === until) {
        await browser.storage.local.remove(SELF_DEPARTURE_UNTIL_KEY);
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
export async function isSelfDepartureActive(): Promise<boolean> {
  let until: unknown;
  try {
    const stored = await browser.storage.local.get(SELF_DEPARTURE_UNTIL_KEY);
    until = stored[SELF_DEPARTURE_UNTIL_KEY];
  } catch {
    return false;
  }
  if (typeof until !== "number") return false;
  const remaining = until - Date.now();
  return remaining > 0 && remaining <= SELF_DEPARTURE_TTL_MS;
}
