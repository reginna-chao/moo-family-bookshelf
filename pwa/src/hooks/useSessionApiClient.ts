import { useLayoutEffect, useMemo } from "react";
import { ApiClient } from "../api/client";
import { USER_ID_KEY, type AuthState } from "./useAuth";

/** True when `a` is still session `b` (the keys that pick the client below). */
export function isSameSession(a: AuthState | null, b: AuthState): boolean {
  return (
    a !== null &&
    a.userId === b.userId &&
    a.familyId === b.familyId &&
    a.apiHost === b.apiHost
  );
}

/**
 * `isSameSession` plus `b.userId` still stored: React state lags a logout issued
 * after an await, but logout / login update `USER_ID_KEY` synchronously.
 */
export function isLiveSession(a: AuthState | null, b: AuthState): boolean {
  return isSameSession(a, b) && localStorage.getItem(USER_ID_KEY) === b.userId;
}

/**
 * One `ApiClient` per login session (#256). A token swap inside the session
 * (401 refresh, QR auto-acquire) keeps the SAME instance — a new one would
 * re-run every page's load and drop unsaved edits — and the layout effect puts
 * the new token on it before any child's passive effect runs.
 *
 * A new session (logout, or a different userId / familyId / apiHost) gets a NEW
 * instance and the previous one is left untouched, token included, so the
 * unmounting subtree's cleanup flush (e.g. the family-shelf prefs `detach()`)
 * still authenticates. A new instance only ever receives the current token.
 */
export function useSessionApiClient(
  auth: AuthState | null,
  tokenRefresher: () => Promise<string | null>,
): ApiClient {
  const apiHost = auth?.apiHost;
  const userId = auth?.userId;
  const familyId = auth?.familyId;
  const authToken = auth?.authToken ?? null;

  const apiClient = useMemo(() => {
    const client = new ApiClient(apiHost);
    client.setTokenRefresher(tokenRefresher);
    return client;
    // userId / familyId are unread on purpose: they key the session, so a new
    // login (or logout) gets a new client instead of nulling the old one's token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiHost, userId, familyId, tokenRefresher]);

  useLayoutEffect(() => {
    apiClient.setAuthToken(authToken);
  }, [apiClient, authToken]);

  return apiClient;
}
