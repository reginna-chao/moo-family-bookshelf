import { useState, useEffect, useCallback } from "react";
import { decodeSyncCode } from "@/crypto/syncCode";

export interface AuthState {
  userId: string;
  familyId: string;
  encryptionKey: string;
  apiHost?: string;
  authToken?: string;
}

export interface UseAuthReturn {
  auth: AuthState | null;
  isLoading: boolean;
  login: (data: AuthState) => void;
  logout: () => void;
  /** Pre-filled sync code from #family= URL parameter (invite link). */
  initialSyncCode: string;
}

/** Bootstrap key — global, not namespaced (needed to find the namespace). */
export const USER_ID_KEY = "moo:userId";

/** Build a namespaced localStorage key: moo:{userId}:{suffix} */
export function namespacedKey(userId: string, suffix: string): string {
  return `moo:${userId}:${suffix}`;
}

/**
 * ACCEPTED RISK: encryptionKey is stored in localStorage as plaintext.
 * PWA has no access to chrome.storage, and sessionStorage would lose state
 * on tab close (unacceptable UX for mobile). Any same-origin script can read
 * localStorage, so an XSS vulnerability could expose the key.
 * Mitigations: strict CSP, no inline scripts, no third-party dependencies at runtime.
 */
function saveToStorage(data: AuthState): void {
  localStorage.setItem(USER_ID_KEY, data.userId);
  localStorage.setItem(namespacedKey(data.userId, "familyId"), data.familyId);
  localStorage.setItem(namespacedKey(data.userId, "encryptionKey"), data.encryptionKey);
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
  const encryptionKey = localStorage.getItem(namespacedKey(userId, "encryptionKey"));
  const apiHost = localStorage.getItem(namespacedKey(userId, "apiHost"));
  const authToken = localStorage.getItem(namespacedKey(userId, "authToken"));

  if (!familyId || !encryptionKey) {
    return null;
  }

  return {
    userId,
    familyId,
    encryptionKey,
    ...(apiHost ? { apiHost } : {}),
    ...(authToken ? { authToken } : {}),
  };
}

function clearStorage(): void {
  const userId = localStorage.getItem(USER_ID_KEY);
  if (userId) {
    localStorage.removeItem(namespacedKey(userId, "familyId"));
    localStorage.removeItem(namespacedKey(userId, "encryptionKey"));
    localStorage.removeItem(namespacedKey(userId, "apiHost"));
    localStorage.removeItem(namespacedKey(userId, "authToken"));
    localStorage.removeItem(namespacedKey(userId, "syncArchived"));
    localStorage.removeItem(namespacedKey(userId, "pwaNoticeShown"));
    localStorage.removeItem(namespacedKey(userId, "installPromptDismissed"));
  }
  localStorage.removeItem(USER_ID_KEY);
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

/**
 * Parse #family={syncCode} from URL hash (invite link flow).
 * Returns the sync code string if found, null otherwise.
 */
function tryParseFamilyParam(): string | null {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  return params.get("family");
}

export function useAuth(): UseAuthReturn {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initialSyncCode, setInitialSyncCode] = useState("");

  useEffect(() => {
    // 1. Parse QR params BEFORE clearing — clearUrlParams removes the hash
    const qrAuth = tryParseQrParams();

    // 2. Parse #family={syncCode} invite link (separate from QR flow)
    const familySyncCode = tryParseFamilyParam();

    // Always clear URL params to avoid leaving encryption key in address bar
    clearUrlParams();

    if (qrAuth) {
      saveToStorage(qrAuth);
      setAuth(qrAuth);
      setIsLoading(false);
      return;
    }

    // Pre-fill sync code from invite link (don't auto-submit)
    if (familySyncCode) {
      setInitialSyncCode(familySyncCode);
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
    clearStorage();
    setAuth(null);
  }, []);

  return { auth, isLoading, login, logout, initialSyncCode };
}
