import { useLayoutEffect, useMemo } from "react";
import { ApiClient } from "../api/client";
import type { AuthState } from "./useAuth";

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
