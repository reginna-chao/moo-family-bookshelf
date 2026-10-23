import { useState, useEffect, useCallback } from "react";
import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import { encodeSyncCode } from "moo-family-bookshelf-shared/crypto/syncCode";
import {
  clearUrlParams,
  tryParseInviteParam,
  tryParseQrParams,
} from "@/utils/authUrlParams";
import { clearReauthPending } from "@/utils/reauthPendingKey";

export interface AuthState {
  userId: string;
  familyId: string;
  apiHost?: string;
  authToken?: string;
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

/** Global key for "remember sync code on logout" preference. */
export const REMEMBER_SYNC_CODE_KEY = "moo:rememberSyncCode";

/** Flag set during remembered logout to trigger sync code pre-fill on next load. */
export const REMEMBERED_LOGOUT_KEY = "moo:rememberedLogout";

/** Bootstrap key — global, not namespaced (needed to find the namespace). */
export const USER_ID_KEY = "moo:userId";

/** Build a namespaced localStorage key: moo:{userId}:{suffix} */
export function namespacedKey(userId: string, suffix: string): string {
  return `moo:${userId}:${suffix}`;
}

/** Canonical form of an API host, or `null` when the client refuses it — the join paths' verdict,
 *  so neither storage nor the in-memory session can hold an endpoint ApiClient would reject. */
function safeApiHost(apiHost: string | undefined): string | null {
  const result = classifySyncCodeApiHost(apiHost);
  return result.kind === "valid" ? result.endpoint : null;
}

function saveToStorage(data: AuthState): void {
  localStorage.setItem(USER_ID_KEY, data.userId);
  localStorage.setItem(namespacedKey(data.userId, "familyId"), data.familyId);
  // Last line of defence for "never persist a refused host"; writing the canonical form makes the
  // remembered sync code rebuilt from it carry the same value the Extension would store.
  const apiHost = safeApiHost(data.apiHost);
  if (apiHost) {
    localStorage.setItem(namespacedKey(data.userId, "apiHost"), apiHost);
  } else {
    localStorage.removeItem(namespacedKey(data.userId, "apiHost"));
  }
  if (data.authToken) {
    localStorage.setItem(
      namespacedKey(data.userId, "authToken"),
      data.authToken,
    );
  } else {
    localStorage.removeItem(namespacedKey(data.userId, "authToken"));
  }
}

function loadFromStorage(): AuthState | null {
  const userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) return null;

  const familyId = localStorage.getItem(namespacedKey(userId, "familyId"));
  const storedApiHost =
    localStorage.getItem(namespacedKey(userId, "apiHost")) || "";
  const authToken = localStorage.getItem(namespacedKey(userId, "authToken"));

  if (!familyId) {
    return null;
  }

  // A stored endpoint the client now refuses would make `new ApiClient` throw and take the app down:
  // drop the session instead (docs/architecture.md → 同步碼位址的驗證與揭露, 本機既有值也會複檢).
  const apiHost = safeApiHost(storedApiHost);
  if (storedApiHost && apiHost === null) {
    return null;
  }

  return {
    userId,
    familyId,
    ...(apiHost ? { apiHost } : {}),
    ...(authToken ? { authToken } : {}),
  };
}

/** Build a remembered sync code from current localStorage, if remember is enabled. */
function buildRememberedSyncCode(): string {
  const remember = localStorage.getItem(REMEMBER_SYNC_CODE_KEY) !== "0";
  if (!remember) return "";

  const userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) return "";

  const familyId = localStorage.getItem(namespacedKey(userId, "familyId"));
  const apiHost = localStorage.getItem(namespacedKey(userId, "apiHost"));
  if (!familyId) return "";

  return encodeSyncCode({ familyId, apiHost: apiHost || undefined });
}

/** Remove all namespaced auth keys for the current user. */
function removeUserKeys(): void {
  const userId = localStorage.getItem(USER_ID_KEY);
  if (userId) {
    localStorage.removeItem(namespacedKey(userId, "familyId"));
    localStorage.removeItem(namespacedKey(userId, "apiHost"));
    localStorage.removeItem(namespacedKey(userId, "authToken"));
    localStorage.removeItem(namespacedKey(userId, "syncArchived"));
    localStorage.removeItem(namespacedKey(userId, "familyShelfViewMode"));
    localStorage.removeItem(namespacedKey(userId, "familyShelfSort"));
    localStorage.removeItem(namespacedKey(userId, "personalShelfSort"));
    localStorage.removeItem(namespacedKey(userId, "pwaNoticeShown"));
    localStorage.removeItem(namespacedKey(userId, "installPromptDismissed"));
  }
  localStorage.removeItem(USER_ID_KEY);
}

function clearStorage(): void {
  // Build sync code BEFORE clearing, if remember is enabled
  const code = buildRememberedSyncCode();
  if (code) {
    localStorage.setItem(REMEMBERED_LOGOUT_KEY, code);
  }

  removeUserKeys();
}

/** Clears ALL localStorage keys unconditionally, including rememberSyncCode. */
export function forceClearStorage(): void {
  removeUserKeys();
  localStorage.removeItem(REMEMBER_SYNC_CODE_KEY);
  localStorage.removeItem(REMEMBERED_LOGOUT_KEY);
  clearReauthPending();
}

/** Ends the current session for a valid invite link. Narrower than forceClearStorage: keeps the
 *  rememberSyncCode preference and the #266 marker (docs/architecture.md → 家庭解綁流程). */
function clearSessionForInvite(): void {
  removeUserKeys();
  localStorage.removeItem(REMEMBERED_LOGOUT_KEY);
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
