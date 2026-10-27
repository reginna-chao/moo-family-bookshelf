import { useEffect, useRef, type RefObject } from "react";
import { isExpiresAt } from "moo-family-bookshelf-shared/api/issuedCredentials";
import { ApiClient } from "@/api/client";
import { isSelfDepartureActive } from "@/utils/selfDeparture";
import type { AuthState } from "./useAuth";
import { isLiveSession } from "./useSessionApiClient";

/** Renew once less than this is left on the token (the Worker issues 90 days). */
export const PROACTIVE_REFRESH_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export interface UseProactiveTokenRefreshParams {
  auth: AuthState | null;
  authRef: RefObject<AuthState | null>;
  login: (data: AuthState) => void;
}

interface RefreshedToken {
  token: string;
  expiresAt?: number;
}

/** No stored expiry (sessions saved before #364, or a rotated token) renews once. */
function needsRefresh(session: AuthState): boolean {
  if (!isExpiresAt(session.expiresAt)) return true;
  return session.expiresAt - Date.now() < PROACTIVE_REFRESH_THRESHOLD_MS;
}

/** `current` is no longer the live session; storage that throws reads as ended. */
function sessionEnded(live: AuthState | null, current: AuthState): boolean {
  try {
    return !isLiveSession(live, current);
  } catch {
    return true;
  }
}

/** One refresh on a throwaway client with no token refresher, so a 401 can never start a
 *  recovery join. Every failure, thrown or returned, reads as `null`. */
async function requestRefresh(
  current: AuthState,
  authToken: string,
): Promise<RefreshedToken | null> {
  try {
    const client = new ApiClient(current.apiHost);
    client.setAuthToken(authToken);
    const res = await client.refreshAuthToken(current.userId, current.familyId);
    return res.data ?? null;
  } catch {
    return null;
  }
}

/** Store the renewed token only while `current` is still the session AND still holds the token
 *  that was sent: a token swapped mid-flight (pin change, recovery join) must not be overwritten. */
function adoptRefreshed(
  authRef: RefObject<AuthState | null>,
  current: AuthState,
  refreshed: RefreshedToken,
  login: (data: AuthState) => void,
): void {
  const live = authRef.current;
  if (live === null || sessionEnded(live, current)) return;
  if (live.authToken !== current.authToken) return;
  const next: AuthState = { ...live, authToken: refreshed.token };
  delete next.expiresAt;
  if (isExpiresAt(refreshed.expiresAt)) next.expiresAt = refreshed.expiresAt;
  login(next);
}

/**
 * Renew the auth token before it expires, checked when a session starts and whenever the app
 * returns to the foreground — never on a timer, never while hidden. A failure changes nothing:
 * the next 401 still goes through the recovery join. Why: docs/architecture.md → PWA 主動續期.
 */
export function useProactiveTokenRefresh({
  auth,
  authRef,
  login,
}: UseProactiveTokenRefreshParams): void {
  const inFlight = useRef<Promise<RefreshedToken | null> | null>(null);

  useEffect(() => {
    if (!auth?.userId) return;
    let cancelled = false;

    const check = async (): Promise<void> => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      const current = authRef.current;
      if (!current?.authToken || !needsRefresh(current)) return;
      // The 429 cooldown is deliberately not consulted: it only gates the recovery join.
      if (isSelfDepartureActive() || sessionEnded(authRef.current, current)) {
        return;
      }
      const run = requestRefresh(current, current.authToken);
      inFlight.current = run;
      try {
        const refreshed = await run;
        if (!cancelled && refreshed) {
          adoptRefreshed(authRef, current, refreshed, login);
        }
      } catch {
        // A failed renewal leaves the session as it was; the next foreground check retries.
      } finally {
        if (inFlight.current === run) inFlight.current = null;
      }
    };

    const onVisibilityChange = (): void => {
      void check();
    };
    void check();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      // A new session's mount check must not wait on the old session's request.
      inFlight.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // Session identity only: a token / expiry dependency would loop refresh → login → refresh when
    // the server grants less than the threshold (docs/architecture.md → PWA 主動續期).
  }, [auth?.userId, auth?.familyId, auth?.apiHost, authRef, login]);
}
