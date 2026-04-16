import { useState, useEffect, useCallback } from "react";
import { decodeSyncCode, encodeSyncCode } from "@/crypto/syncCode";
import { PAGE_HASHES } from "@/routes";

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

function saveToStorage(data: AuthState): void {
  localStorage.setItem(USER_ID_KEY, data.userId);
  localStorage.setItem(namespacedKey(data.userId, "familyId"), data.familyId);
  if (data.apiHost) {
    localStorage.setItem(namespacedKey(data.userId, "apiHost"), data.apiHost);
  } else {
    localStorage.removeItem(namespacedKey(data.userId, "apiHost"));
  }
  if (data.authToken) {
    localStorage.setItem(namespacedKey(data.userId, "authToken"), data.authToken);
  } else {
    localStorage.removeItem(namespacedKey(data.userId, "authToken"));
  }
}

function loadFromStorage(): AuthState | null {
  const userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) return null;

  const familyId = localStorage.getItem(namespacedKey(userId, "familyId"));
  const apiHost = localStorage.getItem(namespacedKey(userId, "apiHost"));
  const authToken = localStorage.getItem(namespacedKey(userId, "authToken"));

  if (!familyId) {
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
}

function clearUrlParams(): void {
  // Preserve page routing hashes (#family-shelf, #personal-shelf, #settings);
  // only clear auth-related hashes (#code=…&uid=…, #invite=…) and query params.
  if (PAGE_HASHES.has(window.location.hash)) return;
  if (window.location.hash || window.location.search) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

interface QrParams {
  syncCode: string;
  userId: string;
}

function tryParseQrParams(): QrParams | null {
  // Read from URL fragment (#) — fragments are never sent to the server,
  // keeping the sync code out of access logs and referrer headers.
  const hash = window.location.hash.slice(1); // remove leading #
  const params = new URLSearchParams(hash);
  const code = params.get("code");
  const uid = params.get("uid");

  if (!code || !uid) {
    return null;
  }

  // Validate that the sync code is decodable before returning
  try {
    decodeSyncCode(code);
  } catch {
    console.warn("QR Code 同步碼解析失敗");
    return null;
  }

  return { syncCode: code, userId: uid };
}

/**
 * Parse #invite={syncCode} from URL hash (invite link flow).
 * Returns the full sync code string if found and valid, null otherwise.
 */
function tryParseInviteParam(): string | null {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const code = params.get("invite");
  if (!code) return null;

  // Validate that the sync code is decodable
  try {
    decodeSyncCode(code);
  } catch {
    console.warn("邀請連結同步碼解析失敗");
    return null;
  }
  return code;
}

export function useAuth(): UseAuthReturn {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initialSyncCode, setInitialSyncCode] = useState("");
  const [qrUserId, setQrUserId] = useState("");

  useEffect(() => {
    // 0. If URL contains "invite=" param key, clear auth state to start fresh for invite.
    const preCheckHashParams = new URLSearchParams(window.location.hash.slice(1));
    const preCheckSearchParams = new URLSearchParams(window.location.search);
    if (preCheckHashParams.has("invite") || preCheckSearchParams.has("invite")) {
      forceClearStorage();
    }

    // 1. Parse QR params BEFORE clearing — clearUrlParams removes the hash.
    //    QR codes include a pre-hashed userId, so we route through LandingPage
    //    verification flow instead of auto-logging in.
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
      setIsLoading(false);
      return;
    }

    // Pre-fill sync code from invite link (don't auto-submit)
    if (inviteSyncCode) {
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
    saveToStorage(data);
    setAuth(data);
  }, []);

  const logout = useCallback((): void => {
    const code = buildRememberedSyncCode();
    clearStorage();
    setAuth(null);
    setQrUserId("");
    if (code) {
      setInitialSyncCode(code);
    }
  }, []);

  const forceLogout = useCallback((): void => {
    forceClearStorage();
    setAuth(null);
    setQrUserId("");
    setInitialSyncCode("");
  }, []);

  return { auth, isLoading, login, logout, forceLogout, initialSyncCode, qrUserId };
}
