import { useCallback, type RefObject } from "react";
import type { AuthState } from "./useAuth";
import { isLiveSession } from "./useSessionApiClient";

/**
 * Persist the auth token a new pin / pattern rotated (#378) into the
 * session, the way the recovery join persists its token: the old one is
 * revoked, and a session still holding it would log the user out at the next
 * reload or recovery join. The returned callback is bound to the session of
 * the render that created it and stores nothing once that session has ended or
 * been replaced (#258), so a late save cannot log a user back in.
 */
export function useRotatedTokenPersistence(
  auth: AuthState | null,
  authRef: RefObject<AuthState | null>,
  login: (data: AuthState) => void,
): (authToken: string) => void {
  return useCallback(
    (authToken: string) => {
      if (auth && isLiveSession(authRef.current, auth)) {
        login({ ...auth, authToken });
      }
    },
    [auth, authRef, login],
  );
}
