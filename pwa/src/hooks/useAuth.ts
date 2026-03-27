import { useState, useEffect, useCallback } from "react";
import { decodeSyncCode } from "@/crypto/syncCode";

export interface AuthState {
  userId: string;
  familyId: string;
  encryptionKey: string;
  apiHost?: string;
}

export interface UseAuthReturn {
  auth: AuthState | null;
  isLoading: boolean;
  login: (data: AuthState) => void;
  logout: () => void;
}

const STORAGE_KEYS = {
  userId: "moo:userId",
  familyId: "moo:familyId",
  encryptionKey: "moo:encryptionKey",
  apiHost: "moo:apiHost",
} as const;

/**
 * ACCEPTED RISK: encryptionKey is stored in localStorage as plaintext.
 * PWA has no access to chrome.storage, and sessionStorage would lose state
 * on tab close (unacceptable UX for mobile). Any same-origin script can read
 * localStorage, so an XSS vulnerability could expose the key.
 * Mitigations: strict CSP, no inline scripts, no third-party dependencies at runtime.
 */
function saveToStorage(data: AuthState): void {
  localStorage.setItem(STORAGE_KEYS.userId, data.userId);
  localStorage.setItem(STORAGE_KEYS.familyId, data.familyId);
  localStorage.setItem(STORAGE_KEYS.encryptionKey, data.encryptionKey);
  if (data.apiHost) {
    localStorage.setItem(STORAGE_KEYS.apiHost, data.apiHost);
  } else {
    localStorage.removeItem(STORAGE_KEYS.apiHost);
  }
}

function loadFromStorage(): AuthState | null {
  const userId = localStorage.getItem(STORAGE_KEYS.userId);
  const familyId = localStorage.getItem(STORAGE_KEYS.familyId);
  const encryptionKey = localStorage.getItem(STORAGE_KEYS.encryptionKey);
  const apiHost = localStorage.getItem(STORAGE_KEYS.apiHost);

  if (!userId || !familyId || !encryptionKey) {
    return null;
  }

  return {
    userId,
    familyId,
    encryptionKey,
    ...(apiHost ? { apiHost } : {}),
  };
}

function clearStorage(): void {
  localStorage.removeItem(STORAGE_KEYS.userId);
  localStorage.removeItem(STORAGE_KEYS.familyId);
  localStorage.removeItem(STORAGE_KEYS.encryptionKey);
  localStorage.removeItem(STORAGE_KEYS.apiHost);
}

function clearUrlParams(): void {
  // Clear both fragment and query params to handle either format
  if (window.location.hash || window.location.search) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

function tryParseQrParams(): AuthState | null {
  // Read from URL fragment (#) — fragments are never sent to the server,
  // keeping the encryption key out of access logs and referrer headers.
  const hash = window.location.hash.slice(1); // remove leading #
  const params = new URLSearchParams(hash);
  const code = params.get("code");
  const uid = params.get("uid");

  if (!code || !uid) {
    return null;
  }

  try {
    const decoded = decodeSyncCode(code);
    return {
      userId: uid,
      familyId: decoded.familyId,
      encryptionKey: decoded.encryptionKey,
      apiHost: decoded.apiHost,
    };
  } catch {
    // Don't log sync code details — it contains the encryption key
    console.warn("QR Code 同步碼解析失敗");
    return null;
  }
}

export function useAuth(): UseAuthReturn {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 1. Parse QR params BEFORE clearing — clearUrlParams removes the hash
    const qrAuth = tryParseQrParams();

    // Always clear URL params to avoid leaving encryption key in address bar
    clearUrlParams();

    if (qrAuth) {
      saveToStorage(qrAuth);
      setAuth(qrAuth);
      setIsLoading(false);
      return;
    }

    // 2. Check localStorage for existing session
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
    clearStorage();
    setAuth(null);
  }, []);

  return { auth, isLoading, login, logout };
}
