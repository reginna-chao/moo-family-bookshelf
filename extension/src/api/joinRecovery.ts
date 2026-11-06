/** The recovery join of the staged token refresh (`auth-refresh.ts`). See docs/architecture.md →
 *  認證更新與冷卻. */

import browser from "webextension-polyfill";
import {
  isAuthToken,
  isExpiresAt,
} from "moo-family-bookshelf-shared/api/issuedCredentials";
import { AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from "../constants";
import { BoolFlag, type ApiResponse } from "./types";

export interface JoinRecoveryDeps {
  request: <T>(
    path: string,
    init?: RequestInit,
    skipRefresh?: boolean,
  ) => Promise<ApiResponse<T>>;
  setAuthToken: (token: string | null) => void;
}

export interface RecoveryResult {
  recovered: boolean;
  /** Backend error code when the recovery join failed. */
  errorCode?: string;
  /** Seconds to wait before retrying, present on rate-limit (429) failures. */
  retryAfter?: number;
}

/**
 * Rejoin the family the refresh started with. `identity` is what `stillOwns`
 * compares against, so it is never re-read from storage here.
 *
 * `stillOwns` runs immediately before the send, with no await between it and
 * `deps.request`, and again on the response; a `false` either way returns no
 * `errorCode`, so the caller takes its transient-failure branch.
 */
export async function attemptJoinRecovery(
  deps: JoinRecoveryDeps,
  identity: { userId: string; familyId: string },
  stillOwns: () => Promise<boolean>,
): Promise<RecoveryResult> {
  // Omit displayName so the backend keeps the member's chosen name; `recovery`
  // lets it refuse a user no longer listed (409 RECOVERY_NOT_MEMBER).
  const joinBody = { userId: identity.userId, recovery: BoolFlag.TRUE };

  if (!(await stillOwns())) return { recovered: false };
  const joinResult = await deps.request<{
    familyId: string;
    ownerId: string;
    members: Array<{ userId: string; displayName: string }>;
    maxMembers: number;
    createdAt: string;
    authToken?: unknown;
    expiresAt?: unknown;
  }>(
    `/api/family/${identity.familyId}/join`,
    {
      method: "POST",
      body: JSON.stringify(joinBody),
    },
    true,
  );
  if (!(await stillOwns())) return { recovered: false };

  // Same rule as the refresh: a token in the wrong shape is a failed recovery.
  const authToken = joinResult.data?.authToken;
  if (isAuthToken(authToken)) {
    deps.setAuthToken(authToken);
    const recoveryUpdate: Record<string, unknown> = {
      [AUTH_TOKEN_KEY]: authToken,
    };
    const expiresAt = joinResult.data?.expiresAt;
    if (isExpiresAt(expiresAt)) {
      recoveryUpdate[TOKEN_EXPIRES_AT_KEY] = expiresAt;
    }
    await browser.storage.local.set(recoveryUpdate);
    return { recovered: true };
  }

  return {
    recovered: false,
    errorCode: joinResult.error?.code,
    retryAfter: joinResult.error?.retryAfter,
  };
}
