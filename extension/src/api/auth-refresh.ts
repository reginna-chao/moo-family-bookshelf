/**
 * Token refresh and recovery logic, extracted from ApiClient.
 */

import browser from "webextension-polyfill";
import type { ApiResponse } from "./types";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from "../constants";

interface RefreshDeps {
  request: <T>(path: string, init?: RequestInit, skipRefresh?: boolean) => Promise<ApiResponse<T>>;
  setAuthToken: (token: string | null) => void;
  onFamilyRemoved: (() => void) | null;
}

/**
 * Attempt to refresh the auth token via /api/auth/refresh.
 * The refresh endpoint is a PROTECTED route — the current Bearer token
 * (even if expired) must be included in the Authorization header.
 * The `deps.request` helper already attaches the token from ApiClient.
 * If refresh fails, attempt staged recovery via joinFamily.
 * If both fail, clear family data and notify via onFamilyRemoved.
 */
export async function doRefreshToken(deps: RefreshDeps): Promise<boolean> {
  try {
    const storage = await browser.storage.local.get([USER_ID_KEY, FAMILY_ID_KEY, AUTH_TOKEN_KEY]);
    const userId = storage[USER_ID_KEY] as string | undefined;
    const familyId = storage[FAMILY_ID_KEY] as string | undefined;
    const storedToken = storage[AUTH_TOKEN_KEY] as string | undefined;
    if (!userId || !familyId) return false;

    // Ensure the current token is set before calling the protected refresh endpoint.
    // This covers edge cases where the in-memory token was cleared but storage still has it.
    if (storedToken) {
      deps.setAuthToken(storedToken);
    }

    const result = await deps.request<{ token: string; expiresAt: number }>(
      "/api/auth/refresh",
      { method: "POST", body: JSON.stringify({ userId, familyId }) },
      true,
    );

    if (result.data?.token) {
      deps.setAuthToken(result.data.token);
      const storageUpdate: Record<string, unknown> = {
        [AUTH_TOKEN_KEY]: result.data.token,
      };
      if (result.data.expiresAt) {
        storageUpdate[TOKEN_EXPIRES_AT_KEY] = result.data.expiresAt;
      }
      await browser.storage.local.set(storageUpdate);
      return true;
    }

    // Refresh failed — attempt staged recovery via joinFamily
    deps.setAuthToken(null);
    await browser.storage.local.remove([AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY]);

    const recovered = await attemptJoinRecovery(deps);
    if (recovered) return true;

    // Recovery also failed — clear family data
    await browser.storage.local.remove([FAMILY_ID_KEY]);
    try {
      await browser.storage.sync.remove([FAMILY_ID_KEY]);
    } catch {
      // sync storage may not be available in all contexts
    }
    try {
      void browser.runtime.sendMessage({ type: "FAMILY_REMOVED" });
    } catch {
      // Message may fail if no listener is active
    }
    deps.onFamilyRemoved?.();

    return false;
  } catch {
    return false;
  }
}

async function attemptJoinRecovery(deps: RefreshDeps): Promise<boolean> {
  const recoveryStorage = await browser.storage.local.get([
    FAMILY_ID_KEY,
    USER_ID_KEY,
  ]);
  const familyId = recoveryStorage[FAMILY_ID_KEY] as string | undefined;
  const userId = recoveryStorage[USER_ID_KEY] as string | undefined;

  if (!familyId || !userId) return false;

  // Build join body — omit displayName so the backend preserves the existing
  // member record (silent recovery must not overwrite the user's chosen name).
  const joinBody: Record<string, string> = { userId };

  const joinResult = await deps.request<{
    familyId: string;
    ownerId: string;
    members: Array<{ userId: string; displayName: string }>;
    maxMembers: number;
    createdAt: string;
    authToken?: string;
    expiresAt?: number;
  }>(
    `/api/family/${familyId}/join`,
    {
      method: "POST",
      body: JSON.stringify(joinBody),
    },
    true,
  );

  if (joinResult.data?.authToken) {
    deps.setAuthToken(joinResult.data.authToken);
    const recoveryUpdate: Record<string, unknown> = {
      [AUTH_TOKEN_KEY]: joinResult.data.authToken,
    };
    if (joinResult.data.expiresAt) {
      recoveryUpdate[TOKEN_EXPIRES_AT_KEY] = joinResult.data.expiresAt;
    }
    await browser.storage.local.set(recoveryUpdate);
    return true;
  }

  return false;
}
