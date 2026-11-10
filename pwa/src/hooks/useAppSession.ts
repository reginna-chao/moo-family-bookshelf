import { useRef } from "react";
import type { ApiClient } from "@/api/client";
import type { AuthState } from "./useAuth";
import { useSessionApiClient } from "./useSessionApiClient";
import { useAutoAcquireToken } from "./useAutoAcquireToken";
import { useProactiveTokenRefresh } from "./useProactiveTokenRefresh";
import { useRecoveryJoin } from "./useRecoveryJoin";
import { useRotatedTokenPersistence } from "./useRotatedTokenPersistence";
import { useDepartureLogout, type DepartureLogout } from "./useDepartureLogout";

interface UseAppSessionParams {
  auth: AuthState | null;
  login: (data: AuthState) => void;
  logout: () => void;
  forceLogout: () => void;
  dropSession: () => void;
  setLandingError: (message: string) => void;
}

interface AppSession {
  apiClient: ApiClient;
  acquiringToken: boolean;
  persistRotatedToken: (authToken: string) => void;
  departureLogout: DepartureLogout;
}

/** The session plumbing of `App`: its API client, the background token recovery and renewal,
 *  and the leave / delete logouts bound to the session that sent them. */
export function useAppSession({
  auth,
  login,
  logout,
  forceLogout,
  dropSession,
  setLandingError,
}: UseAppSessionParams): AppSession {
  // The live session for callbacks that outlive a render (recovery join, renewal, token rotation).
  const authRef = useRef(auth);
  authRef.current = auth;

  const acquireNewToken = useRecoveryJoin({
    authRef,
    login,
    logout,
    setLandingError,
  });
  useProactiveTokenRefresh({ auth, authRef, login });

  // Same client across a token swap, new one per session (#256) — see the hook.
  const apiClient = useSessionApiClient(auth, acquireNewToken);
  const acquiringToken = useAutoAcquireToken(auth, acquireNewToken);
  const persistRotatedToken = useRotatedTokenPersistence(auth, authRef, login);
  const departureLogout = useDepartureLogout({
    auth,
    authRef,
    logout,
    forceLogout,
    dropSession,
  });

  return { apiClient, acquiringToken, persistRotatedToken, departureLogout };
}
