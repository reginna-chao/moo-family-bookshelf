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
 * If that fails, attempt staged recovery via joinFamily.
 * If both fail, clear family data and notify via onFamilyRemoved.
 */
export async function doRefreshToken(deps: RefreshDeps): Promise<boolean> {
  try {
    const storage = await chrome.storage.local.get(["userId", "familyId"]);
    const userId = storage.userId as string | undefined;
    const familyId = storage.familyId as string | undefined;
    if (!userId || !familyId) return false;

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
    await chrome.storage.local.remove(["familyId", "encryptionKey"]);
    try {
      await chrome.storage.sync.remove(["familyId", "encryptionKey"]);
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
    "displayName",
  ]);
  const familyId = recoveryStorage.familyId as string | undefined;
  const userId = recoveryStorage.userId as string | undefined;
  const displayName = (recoveryStorage.displayName as string | undefined) ?? "";

  if (!familyId || !userId) return false;

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
      body: JSON.stringify({ userId, displayName }),
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
