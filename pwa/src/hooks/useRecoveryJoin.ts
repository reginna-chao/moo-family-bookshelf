import { useCallback, type RefObject } from "react";
import { isExpiresAt } from "moo-family-bookshelf-shared/api/issuedCredentials";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { ApiClient } from "@/api/client";
import type { AuthState } from "./useAuth";
import { isLiveSession } from "./useSessionApiClient";
import { recoveryJoinBlocked } from "./recoveryJoinGate";
import {
  JOIN_BLOCKED_MESSAGES,
  REVERIFY_LOGOUT_MESSAGE,
  VERIFICATION_ERROR_CODES,
} from "@/utils/joinErrorMessages";
import {
  clearRecoveryCooldown,
  setRecoveryCooldown,
} from "@/utils/recoveryCooldown";
import { markReauthPending } from "@/utils/reauthPending";
import { rememberSyncCodeForRelogin } from "@/utils/reloginSyncCode";

export interface UseRecoveryJoinParams {
  authRef: RefObject<AuthState | null>;
  login: (data: AuthState) => void;
  logout: () => void;
  setLandingError: (message: string) => void;
}

/**
 * The silent recovery join: re-join the family to get a fresh token, used both on init and on 401
 * refresh. The returned function keeps its identity across token swaps and re-renders, so
 * `useSessionApiClient` does not build a new client (#256).
 */
export function useRecoveryJoin({
  authRef,
  login,
  logout,
  setLandingError,
}: UseRecoveryJoinParams): () => Promise<string | null> {
  return useCallback(async (): Promise<string | null> => {
    const current = authRef.current;
    if (!current) return null;
    // Skip on a 429 cooldown, while this user's own leave / delete is in flight
    // (#263), or once the session has ended — see `recoveryJoinBlocked`.
    if (recoveryJoinBlocked(authRef.current, current)) return null;

    const tempClient = new ApiClient(current.apiHost);
    // Refresh endpoint is protected — include current token for authentication
    tempClient.setAuthToken(current.authToken ?? null);
    // `recovery` lets the server refuse a non-member (409 RECOVERY_NOT_MEMBER).
    const res = await tempClient.joinFamily(current.familyId, current.userId, {
      recovery: BoolFlag.TRUE,
    });
    // Logged out or switched session mid-join (#258): drop the stale result.
    if (!isLiveSession(authRef.current, current)) return null;
    if (res.error) {
      const { code, retryAfter } = res.error;
      // A blocked code is terminal, so the logout is earned (Map `.get`: the
      // code is backend-controlled). Same split as `extension/src/api/auth-refresh.ts`.
      const blockedMessage = JOIN_BLOCKED_MESSAGES.get(code);
      if (blockedMessage !== undefined) {
        setLandingError(blockedMessage);
        logout();
        return null;
      }
      if (VERIFICATION_ERROR_CODES.has(code)) {
        setLandingError(REVERIFY_LOGOUT_MESSAGE);
        rememberSyncCodeForRelogin(current);
        logout();
        // After logout (an await first reopens #258); lands before any re-login (#266).
        await markReauthPending(current);
        return null;
      }
      // Any other failure (shared-NAT 429, dropped connection, unknown code) KEEPS
      // the session (Invariant 2); only the quota failure earns a cooldown.
      if (code === "RATE_LIMITED") {
        setRecoveryCooldown(retryAfter);
      }
      return null;
    }
    if (res.data?.authToken) {
      clearRecoveryCooldown();
      // The new token's own expiry, never `current`'s: a missing one reads as unknown.
      const next: AuthState = { ...current, authToken: res.data.authToken };
      delete next.expiresAt;
      if (isExpiresAt(res.data.expiresAt)) next.expiresAt = res.data.expiresAt;
      login(next);
      return res.data.authToken;
    }
    return null;
  }, [authRef, login, logout, setLandingError]);
}
