import type { AuthState } from "./useAuth";
import { isLiveSession } from "./useSessionApiClient";
import { getActiveRecoveryCooldown } from "@/utils/recoveryCooldown";
import { isSelfDepartureActive } from "@/utils/selfDeparture";

/**
 * True when the PWA's silent recovery join (`acquireNewToken` in
 * `pwa/src/App.tsx`) must NOT be sent for session `current`:
 *  - a 429 cooldown is active — every 401 retries through the refresher and the
 *    join spends the worker's per-IP 3/min tier (LandingPage joins bypass this);
 *  - this user's own leave / delete-account request is in flight in any tab
 *    (#263) — a join now could re-add them to the family they are leaving;
 *  - the session already ended: `live` is no longer `current`, or `USER_ID_KEY`
 *    moved (`isLiveSession`). Storage that throws reads as ended, as the same
 *    check after the join would throw too.
 */
export function recoveryJoinBlocked(
  live: AuthState | null,
  current: AuthState,
): boolean {
  if (getActiveRecoveryCooldown() !== undefined) return true;
  if (isSelfDepartureActive()) return true;
  try {
    return !isLiveSession(live, current);
  } catch {
    return true;
  }
}
