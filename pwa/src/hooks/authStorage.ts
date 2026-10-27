/** localStorage layer of `useAuth`: the session keys and how they are written, read and cleared.
 *  Must never reach `pwa/src/constants.ts` (.claude/rules/frontend.md → PWA import chain). */

import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import { isExpiresAt } from "moo-family-bookshelf-shared/api/issuedCredentials";
import { encodeSyncCode } from "moo-family-bookshelf-shared/crypto/syncCode";
import { clearReauthPending } from "@/utils/reauthPendingKey";
import type { AuthState } from "./useAuth";

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
export function safeApiHost(apiHost: string | undefined): string | null {
  const result = classifySyncCodeApiHost(apiHost);
  return result.kind === "valid" ? result.endpoint : null;
}

export function saveToStorage(data: AuthState): void {
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
  if (isExpiresAt(data.expiresAt)) {
    localStorage.setItem(
      namespacedKey(data.userId, "tokenExpiresAt"),
      String(data.expiresAt),
    );
  } else {
    localStorage.removeItem(namespacedKey(data.userId, "tokenExpiresAt"));
  }
}

export function loadFromStorage(): AuthState | null {
  const userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) return null;

  const familyId = localStorage.getItem(namespacedKey(userId, "familyId"));
  const storedApiHost =
    localStorage.getItem(namespacedKey(userId, "apiHost")) || "";
  const authToken = localStorage.getItem(namespacedKey(userId, "authToken"));
  // An unusable stored expiry reads as none: the proactive refresh then renews once.
  const expiresAt = Number(
    localStorage.getItem(namespacedKey(userId, "tokenExpiresAt")),
  );

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
    ...(isExpiresAt(expiresAt) ? { expiresAt } : {}),
  };
}

/** Build a remembered sync code from current localStorage, if remember is enabled. */
export function buildRememberedSyncCode(): string {
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
    localStorage.removeItem(namespacedKey(userId, "tokenExpiresAt"));
    localStorage.removeItem(namespacedKey(userId, "syncArchived"));
    localStorage.removeItem(namespacedKey(userId, "familyShelfViewMode"));
    localStorage.removeItem(namespacedKey(userId, "familyShelfSort"));
    localStorage.removeItem(namespacedKey(userId, "personalShelfSort"));
    localStorage.removeItem(namespacedKey(userId, "pwaNoticeShown"));
    localStorage.removeItem(namespacedKey(userId, "installPromptDismissed"));
  }
  localStorage.removeItem(USER_ID_KEY);
}

export function clearStorage(): void {
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
export function clearSessionForInvite(): void {
  removeUserKeys();
  localStorage.removeItem(REMEMBERED_LOGOUT_KEY);
}
