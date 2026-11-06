import { useEffect, useRef, useState } from "react";
import type { AuthState } from "./useAuth";
import type { SessionTokenRefresher } from "./useSessionApiClient";

/** Auto-acquire an auth token once when the session has none (e.g., QR code entry); true while it runs. */
export function useAutoAcquireToken(
  auth: AuthState | null,
  acquireNewToken: SessionTokenRefresher,
): boolean {
  const [acquiringToken, setAcquiringToken] = useState(false);
  const tokenAcquired = useRef(false);
  useEffect(() => {
    if (!auth || auth.authToken || tokenAcquired.current) return;
    tokenAcquired.current = true;
    setAcquiringToken(true);

    void acquireNewToken(auth).finally(() => setAcquiringToken(false));
  }, [auth, acquireNewToken]);
  return acquiringToken;
}
