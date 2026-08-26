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
  RECOVERY_COOLDOWN_UNTIL_KEY,
} from "../constants";
import { resetFamilyEndpointChoice } from "../storage/familyEndpointChoice";

/** Fallback cooldown (seconds) when a 429 body omits `retryAfter`. */
const DEFAULT_RECOVERY_COOLDOWN_SECONDS = 300;

/**
 * Upper bound (1 hour) applied to any backend-supplied `retryAfter`. The official
 * worker never asks for more than 900s, so this only guards against a hostile or
 * buggy self-hosted (BYO) backend locking recovery out effectively forever.
 * Mirrors the cap in `dialog/useRetryCountdown.ts`; kept local so the api layer
 * does not depend on the dialog layer.
 */
const MAX_RECOVERY_COOLDOWN_SECONDS = 3600;

/**
 * Backend join error codes that mean the member exists but must supply their
 * PWA-login verification secret (PIN/pattern/OTP). Mirrors the set in
 * `dialog/useVerificationPrompt.ts`; kept local so the api layer does not
 * depend on the dialog layer.
 */
const VERIFICATION_ERROR_CODES = new Set([
  "VERIFICATION_REQUIRED",
  "VERIFICATION_FAILED",
  "VERIFICATION_LOCKED",
]);

/**
 * Backend join error codes that mean the family is genuinely gone for this user,
 * so retrying the recovery join can never succeed:
 *  - FAMILY_NOT_FOUND — the family record itself is gone.
 *  - FAMILY_FULL      — no seat left to rejoin.
 *  - MEMBER_REMOVED   — the owner removed this member and the server's kicked
 *                       tombstone is refusing the rejoin. Without this code the
 *                       client would silently auto-rejoin once the tombstone
 *                       expires, undoing the removal; treat it as "family gone
 *                       for this user" — stop retrying, clear local family data.
 *
 * Only these justify clearing the local family data — anything else
 * (network/transient/verification) must not silently drop the user's data
 * (security-ux Invariant 2).
 *
 * The set stays private; everyone classifies through `isFamilyGoneError` below,
 * so there is exactly one definition of "gone" in the codebase.
 */
const FAMILY_GONE_ERROR_CODES = new Set([
  "FAMILY_NOT_FOUND",
  "FAMILY_FULL",
  "MEMBER_REMOVED",
]);

/**
 * True when a join errorCode means the join target is gone for THIS user, so no
 * retry can succeed — not even one carrying a correct verification secret.
 *
 * Exported because the dialog's re-verification flow runs its own join
 * (`dialog/useReauth.ts`) and must reach the identical verdict: without it, a
 * removed member who types the correct PIN only ever sees a retryable error and
 * loops until the server's kicked tombstone expires. The dependency direction is
 * dialog → api, which is the allowed one.
 *
 * Returns a type predicate so callers that need the narrowed `string` (e.g. to
 * forward the code onward) get it from here rather than re-checking `undefined`
 * themselves — that second check would be a duplicate of this contract.
 */
export function isFamilyGoneError(code: string | undefined): code is string {
  return code !== undefined && FAMILY_GONE_ERROR_CODES.has(code);
}

/**
 * What blocked the silent recovery, handed to `onReauthRequired` so the prompt
 * can open in the right state (e.g. VERIFICATION_LOCKED renders the countdown
 * immediately instead of an active pin/pattern input).
 */
export interface ReauthInfo {
  errorCode: string;
  /** Seconds to wait before retrying, present on lockout / rate-limit failures. */
  retryAfter?: number;
}

/**
 * Why the local family binding was torn down, handed to `onFamilyRemoved` so the
 * UI can explain the flip back to onboarding instead of leaving the user in
 * front of a silently reset dialog.
 *
 * `errorCode` is always one of the `FAMILY_GONE_ERROR_CODES` members: both
 * teardown entry points classify through `isFamilyGoneError` before running.
 */
export interface FamilyRemovedInfo {
  errorCode: string;
}

interface RefreshDeps {
  request: <T>(
    path: string,
    init?: RequestInit,
    skipRefresh?: boolean,
  ) => Promise<ApiResponse<T>>;
  setAuthToken: (token: string | null) => void;
  /** Invoked when the family is genuinely gone — clears local family data. */
  onFamilyRemoved: ((info: FamilyRemovedInfo) => void) | null;
  /** Invoked when recovery needs a PWA-login verification secret (re-verify). */
  onReauthRequired: ((info?: ReauthInfo) => void) | null;
  /**
   * Returns true when a re-verification prompt is already pending from an
   * earlier 401 wave. When latched, silent join-recovery is skipped so the
   * dialog's second data wave does not re-spend the join rate-limit budget nor
   * re-initialize the verification prompt (which would wipe in-progress
   * pattern/PIN input).
   */
  isReauthPending: () => boolean;
}

interface RecoveryResult {
  recovered: boolean;
  /** Backend error code when the recovery join failed. */
  errorCode?: string;
  /** Seconds to wait before retrying, present on rate-limit (429) failures. */
  retryAfter?: number;
}

/**
 * Structured outcome of a refresh attempt. Replaces the old boolean so the
 * ApiClient's 401 path can distinguish a rate-limited failure (surface a
 * friendly message, do NOT prompt verification) from other failures.
 */
export interface RefreshOutcome {
  /** True when a valid token was acquired (refresh or recovery). */
  refreshed: boolean;
  /** True when the failure was caused by rate limiting (fresh 429 or active cooldown). */
  rateLimited?: boolean;
  /** Epoch ms when the recovery cooldown ends, when known. */
  cooldownUntil?: number;
}

/**
 * Attempt to refresh the auth token via /api/auth/refresh.
 * The refresh endpoint is a PROTECTED route — the current Bearer token
 * (even if expired) must be included in the Authorization header.
 * The `deps.request` helper already attaches the token from ApiClient.
 * If refresh fails, attempt staged recovery via joinFamily.
 *
 * On recovery failure the branch matters (Invariant 2 — never silently drop
 * data on token expiry):
 *  - rate-limited (429)  → set a cooldown, surface a friendly message, keep data,
 *                          and do NOT prompt verification (429 fires before the
 *                          server's verification gate).
 *  - verification codes  → prompt re-verification via onReauthRequired, keep data.
 *  - family-gone codes   → clear local family data + FAMILY_REMOVED.
 *  - anything else        → leave data intact so a later request can retry.
 *
 * The recovery join is quota-sensitive (the worker rate-limits it per-IP on the
 * sensitive tier — 3/min), so an active cooldown suppresses the auto-join
 * entirely — but never a manual, user-initiated join (onboarding / re-verify),
 * which live outside this module.
 */
export async function doRefreshToken(
  deps: RefreshDeps,
): Promise<RefreshOutcome> {
  try {
    const storage = await browser.storage.local.get([
      USER_ID_KEY,
      FAMILY_ID_KEY,
      AUTH_TOKEN_KEY,
    ]);
    const userId = storage[USER_ID_KEY] as string | undefined;
    const familyId = storage[FAMILY_ID_KEY] as string | undefined;
    const storedToken = storage[AUTH_TOKEN_KEY] as string | undefined;
    if (!userId || !familyId) return { refreshed: false };

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
      await clearRecoveryCooldown();
      return { refreshed: true };
    }

    // Refresh failed — attempt staged recovery via joinFamily
    deps.setAuthToken(null);
    await browser.storage.local.remove([AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY]);

    // Reauth-pending guard: a verification prompt was already raised by an
    // earlier 401 wave. The refresh POST above still ran (a token fixed in
    // storage by another tab/context is picked up at the top of this function
    // and can recover without a join), but silent join-recovery must NOT fire a
    // second time — it would re-spend the per-IP join budget and re-fire
    // onReauthRequired, wiping the user's in-progress pattern/PIN input.
    if (deps.isReauthPending()) {
      return { refreshed: false };
    }

    // The join is quota-sensitive. If a cooldown from a prior 429 is still active,
    // skip the auto-join entirely (treat like a transient failure, keep data) and
    // surface the rate-limit state so the UI can show a friendly message.
    const activeCooldownUntil = await getActiveRecoveryCooldown();
    if (activeCooldownUntil !== undefined) {
      return {
        refreshed: false,
        rateLimited: true,
        cooldownUntil: activeCooldownUntil,
      };
    }

    const recovery = await attemptJoinRecovery(deps);
    if (recovery.recovered) {
      await clearRecoveryCooldown();
      return { refreshed: true };
    }

    // Rate-limited by the worker. A no-secret recovery can only hit the per-IP
    // sensitive tier's 429 (the verify attempt ceiling charges wrong guesses
    // only, and never fires without a secret). Set a cooldown so subsequent
    // dialog opens stop burning the shared quota, and do NOT prompt
    // verification — a verified retry from the same IP would still be blocked
    // by the same per-IP window.
    if (recovery.errorCode === "RATE_LIMITED") {
      const cooldownUntil = await setRecoveryCooldown(recovery.retryAfter);
      return { refreshed: false, rateLimited: true, cooldownUntil };
    }

    // Verification-enabled member on a dead token: DO NOT clear family data.
    // Prompt the user to re-verify instead (Invariant 2).
    if (
      recovery.errorCode &&
      VERIFICATION_ERROR_CODES.has(recovery.errorCode)
    ) {
      deps.onReauthRequired?.({
        errorCode: recovery.errorCode,
        retryAfter: recovery.retryAfter,
      });
      return { refreshed: false };
    }

    // Family genuinely gone — clear local family data and notify.
    if (isFamilyGoneError(recovery.errorCode)) {
      await clearFamilyAndNotify(deps, recovery.errorCode);
      return { refreshed: false };
    }

    // Transient / unknown failure — leave family data intact so a later request
    // can retry. Silently clearing here would violate Invariant 2.
    return { refreshed: false };
  } catch {
    return { refreshed: false };
  }
}

/** Read the recovery cooldown, returning its epoch-ms deadline only if still active. */
async function getActiveRecoveryCooldown(): Promise<number | undefined> {
  const stored = await browser.storage.local.get(RECOVERY_COOLDOWN_UNTIL_KEY);
  const cooldownUntil = stored[RECOVERY_COOLDOWN_UNTIL_KEY];
  if (typeof cooldownUntil !== "number") return undefined;
  // Clamp on read as well as on write: a deadline persisted before the write-side
  // cap existed (or one inflated by a clock skew) must not outlive the max.
  const now = Date.now();
  const bounded = Math.min(
    cooldownUntil,
    now + MAX_RECOVERY_COOLDOWN_SECONDS * 1000,
  );
  return now < bounded ? bounded : undefined;
}

/**
 * Persist a fresh recovery cooldown; returns the epoch-ms deadline written.
 * The requested wait is clamped to `MAX_RECOVERY_COOLDOWN_SECONDS` so an
 * untrusted backend cannot suppress auto-recovery indefinitely.
 */
async function setRecoveryCooldown(
  retryAfterSeconds?: number,
): Promise<number> {
  const requested =
    typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_RECOVERY_COOLDOWN_SECONDS;
  const seconds = Math.min(requested, MAX_RECOVERY_COOLDOWN_SECONDS);
  const cooldownUntil = Date.now() + seconds * 1000;
  await browser.storage.local.set({
    [RECOVERY_COOLDOWN_UNTIL_KEY]: cooldownUntil,
  });
  return cooldownUntil;
}

/** Clear the recovery cooldown so a recovered client is never stale-throttled. */
async function clearRecoveryCooldown(): Promise<void> {
  await browser.storage.local.remove(RECOVERY_COOLDOWN_UNTIL_KEY);
}

/**
 * Clear local + synced family data, drop this device's family-scoped API
 * endpoint choice, and broadcast FAMILY_REMOVED.
 *
 * Exported for the dialog's re-verification flow (`dialog/useReauth.ts`), whose
 * own join can be refused with a family-gone code after the silent recovery was
 * blocked by the verification gate: it needs byte-identical teardown, and a
 * second copy of these steps is exactly how the two paths would drift. Housing
 * the endpoint reset here (rather than in each caller) is what structurally
 * guarantees that parity.
 *
 * The endpoint reset drops BOTH the accepted endpoint and the declined marker,
 * for the same reason `resetFamilyEndpointChoice` gives for a voluntary leave:
 * the endpoint is a FAMILY-scoped setting (the owner picks it, every member
 * adopts it) and must not outlive the membership. A client left pointing at a
 * former family's server would send the next create/join there — userId,
 * display name, the auth token that server issues, and the whole personal book
 * list, unshared books included — and would bake that host into the sync code it
 * hands out next. Being removed ends the membership exactly like leaving does.
 * `resetFamilyEndpointChoice` swallows its own storage failures, so it cannot
 * abort the teardown. It runs AFTER the family-id removals so the endpoint is
 * never reset while the family binding still stands.
 *
 * Deliberately does NOT invoke `onFamilyRemoved` — reacting in the UI is the
 * caller's business, and the two callers do it at different moments.
 */
export async function clearFamilyStorageAndBroadcast(): Promise<void> {
  await browser.storage.local.remove([FAMILY_ID_KEY]);
  try {
    await browser.storage.sync.remove([FAMILY_ID_KEY]);
  } catch {
    // sync storage may not be available in all contexts
  }
  await resetFamilyEndpointChoice();
  void Promise.resolve(
    browser.runtime.sendMessage({ type: "FAMILY_REMOVED" }),
  ).catch(() => {
    // Message may fail if no listener is active
  });
}

/** Clear the family data, then hand the refresh caller its notification. */
async function clearFamilyAndNotify(
  deps: RefreshDeps,
  errorCode: string,
): Promise<void> {
  await clearFamilyStorageAndBroadcast();
  deps.onFamilyRemoved?.({ errorCode });
}

async function attemptJoinRecovery(deps: RefreshDeps): Promise<RecoveryResult> {
  const recoveryStorage = await browser.storage.local.get([
    FAMILY_ID_KEY,
    USER_ID_KEY,
  ]);
  const familyId = recoveryStorage[FAMILY_ID_KEY] as string | undefined;
  const userId = recoveryStorage[USER_ID_KEY] as string | undefined;

  if (!familyId || !userId) return { recovered: false };

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
    return { recovered: true };
  }

  return {
    recovered: false,
    errorCode: joinResult.error?.code,
    retryAfter: joinResult.error?.retryAfter,
  };
}
