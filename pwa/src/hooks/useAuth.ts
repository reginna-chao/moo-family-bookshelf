import { useState, useEffect, useCallback } from "react";
import {
  clearUrlParams,
  tryParseInviteParam,
  tryParseQrParams,
} from "@/utils/authUrlParams";
import {
  buildRememberedSyncCode,
  clearSessionForInvite,
  clearStorage,
  forceClearStorage,
  loadFromStorage,
  safeApiHost,
  saveToStorage,
} from "./authStorage";

// The storage keys and the force-clear live in authStorage.ts; re-exported for existing importers.
export {
  REMEMBER_SYNC_CODE_KEY,
  REMEMBERED_LOGOUT_KEY,
  USER_ID_KEY,
  namespacedKey,
  forceClearStorage,
} from "./authStorage";

export interface AuthState {
  userId: string;
  familyId: string;
  apiHost?: string;
  authToken?: string;
  /** Token expiry (epoch ms) as the server issued it; absent when unknown. */
  expiresAt?: number;
}

export interface UseAuthReturn {
  auth: AuthState | null;
  isLoading: boolean;
  login: (data: AuthState) => void;
  logout: () => void;
  /** Clears everything unconditionally, ignoring rememberSyncCode. Used by delete account. */
  forceLogout: () => void;
  /** Pre-filled sync code from QR code, invite link, or remembered logout. */
  initialSyncCode: string;
  /** Pre-hashed userId from QR code (#code=…&uid=…). Skips email entry on LandingPage. */
  qrUserId: string;
  /** Short-lived QR token from Extension (#qrt=…). Bypasses PWA verification when valid. */
  qrToken: string;
}

export function useAuth(): UseAuthReturn {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initialSyncCode, setInitialSyncCode] = useState("");
  const [qrUserId, setQrUserId] = useState("");
  const [qrToken, setQrToken] = useState("");

  useEffect(() => {
    // 1. Parse QR params BEFORE clearUrlParams removes the hash. A QR's pre-hashed userId goes
    //    through LandingPage's verification flow instead of auto-logging in.
    const qrParams = tryParseQrParams();

    // 2. Parse #invite={syncCode} invite link (separate from QR flow)
    const inviteSyncCode = tryParseInviteParam();

    // Always clear URL params to avoid leaving sync code in address bar
    clearUrlParams();

    if (qrParams) {
      // Clear any existing auth to force fresh login through LandingPage
      forceClearStorage();
      setInitialSyncCode(qrParams.syncCode);
      setQrUserId(qrParams.userId);
      if (qrParams.qrToken) {
        setQrToken(qrParams.qrToken);
      }
      setIsLoading(false);
      return;
    }

    // Only a decodable invite ends the current session (before step 3), then pre-fills (no auto-submit)
    if (inviteSyncCode) {
      clearSessionForInvite();
      setInitialSyncCode(inviteSyncCode);
    }

    // 3. Check localStorage for existing session
    const stored = loadFromStorage();
    if (stored) {
      setAuth(stored);
    }

    setIsLoading(false);
  }, []);

  const login = useCallback((data: AuthState): void => {
    const apiHost = safeApiHost(data.apiHost);

    // Fail closed like loadFromStorage: keeping a refused host in state would
    // white-screen `new ApiClient` now and fall back to the DEFAULT endpoint on reload.
    if (data.apiHost && apiHost === null) {
      console.warn(
        "[useAuth] Refusing to start a session on an unusable endpoint",
      );
      return;
    }

    // Store the CANONICAL host in React state too, so `auth.apiHost` cannot
    // differ from the persisted value across a reload.
    const session: AuthState = { ...data };
    if (apiHost === null) {
      delete session.apiHost;
    } else {
      session.apiHost = apiHost;
    }
    saveToStorage(session);
    setAuth(session);
  }, []);

  const logout = useCallback((): void => {
    const code = buildRememberedSyncCode();
    clearStorage();
    setAuth(null);
    setQrUserId("");
    setQrToken("");
    if (code) {
      setInitialSyncCode(code);
    }
  }, []);

  const forceLogout = useCallback((): void => {
    forceClearStorage();
    setAuth(null);
    setQrUserId("");
    setQrToken("");
    setInitialSyncCode("");
  }, []);

  return {
    auth,
    isLoading,
    login,
    logout,
    forceLogout,
    initialSyncCode,
    qrUserId,
    qrToken,
  };
}
