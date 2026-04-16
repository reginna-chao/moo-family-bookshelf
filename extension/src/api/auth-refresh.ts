/**
 * Token refresh and recovery logic, extracted from ApiClient.
 */

import type { ApiResponse } from "./types";

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
    const storage = await chrome.storage.local.get(["userId", "familyId", "authToken"]);
    const userId = storage.userId as string | undefined;
    const familyId = storage.familyId as string | undefined;
    const storedToken = storage.authToken as string | undefined;
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
        authToken: result.data.token,
      };
      if (result.data.expiresAt) {
        storageUpdate.tokenExpiresAt = result.data.expiresAt;
      }
      await chrome.storage.local.set(storageUpdate);
      return true;
    }

    // Refresh failed — attempt staged recovery via joinFamily
    deps.setAuthToken(null);
    await chrome.storage.local.remove(["authToken", "tokenExpiresAt"]);

    const recovered = await attemptJoinRecovery(deps);
    if (recovered) return true;

    // Recovery also failed — clear family data
    await chrome.storage.local.remove(["familyId"]);
    try {
      await chrome.storage.sync.remove(["familyId"]);
    } catch {
      // sync storage may not be available in all contexts
    }
    try {
      chrome.runtime.sendMessage({ type: "FAMILY_REMOVED" });
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
  const recoveryStorage = await chrome.storage.local.get([
    "familyId",
    "userId",
  ]);
  const familyId = recoveryStorage.familyId as string | undefined;
  const userId = recoveryStorage.userId as string | undefined;

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
      authToken: joinResult.data.authToken,
    };
    if (joinResult.data.expiresAt) {
      recoveryUpdate.tokenExpiresAt = joinResult.data.expiresAt;
    }
    await chrome.storage.local.set(recoveryUpdate);
    return true;
  }

  return false;
}
