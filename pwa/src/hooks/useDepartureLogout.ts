import { useMemo, type RefObject } from "react";
import type { AuthState } from "./useAuth";
import { isLiveSession, isSameSession } from "./useSessionApiClient";
import { storageHoldsNoSession } from "./authStorage";

/** The logout to run after a successful leave / delete, bound to the session that sent it. */
export interface DepartureLogout {
  afterLeave: () => void;
  afterDelete: () => void;
}

interface UseDepartureLogoutParams {
  auth: AuthState | null;
  authRef: RefObject<AuthState | null>;
  logout: () => void;
  forceLogout: () => void;
  dropSession: () => void;
}

/**
 * Logout callbacks for a leave / delete response that may land after this tab or another one has
 * moved on. This tab no longer on the sending session → nothing; storage still holding it, or no
 * session at all → the full logout; storage holding ANOTHER session → only this tab's screen ends
 * (`dropSession`), so the other tab's login survives. Why: docs/architecture.md → 背景自動復原的防護.
 */
export function useDepartureLogout({
  auth,
  authRef,
  logout,
  forceLogout,
  dropSession,
}: UseDepartureLogoutParams): DepartureLogout {
  return useMemo(() => {
    const settle = (fullLogout: () => void): void => {
      if (!auth || !isSameSession(authRef.current, auth)) return;
      if (isLiveSession(authRef.current, auth) || storageHoldsNoSession()) {
        fullLogout();
        return;
      }
      dropSession();
    };
    return {
      afterLeave: () => settle(logout),
      afterDelete: () => settle(forceLogout),
    };
  }, [auth, authRef, logout, forceLogout, dropSession]);
}
