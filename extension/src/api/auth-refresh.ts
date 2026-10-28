/** Token refresh and recovery logic, extracted from ApiClient. */

import browser from "webextension-polyfill";
import { BoolFlag, type ApiResponse } from "./types";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from "../constants";
import { resetFamilyEndpointChoice } from "../storage/familyEndpointChoice";
import { isSelfDepartureActive } from "../storage/selfDeparture";
import {
  isAuthToken,
  isExpiresAt,
} from "moo-family-bookshelf-shared/api/issuedCredentials";
import {
  clearRecoveryCooldown,
  getActiveRecoveryCooldown,
  setRecoveryCooldown,
} from "./recoveryCooldown";

/** Join codes meaning "member exists, supply the PWA-login secret (PIN/pattern/OTP)". Mirrors
 *  `dialog/useVerificationPrompt.ts`, kept local so the api layer never imports the dialog layer. */
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
 *  - RECOVERY_NOT_MEMBER — this user is no longer listed in the family, and
 *                       the server refuses a `recovery: 1` join from a non-member.
 *
 * Only these justify clearing the local family data — anything else
 * (network/transient/verification) must not silently drop the user's data
 * (security-ux Invariant 2).
 *
 * Exported READ-ONLY (`ReadonlySet`) for one consumer: the copy-coverage test
 * `extension/tests/unit/dialog/familyGoneNotice.test.ts`, which asserts every
 * code here has a reason in `dialog/familyGoneNotice.ts` — without it a code
 * added only here would silently degrade to the generic fallback banner.
 *
 * Runtime classification still goes exclusively through `isFamilyGoneError`
 * below — it stays the one definition of "gone" in the codebase. Do not
 * membership-test this set directly.
 */
export const FAMILY_GONE_ERROR_CODES: ReadonlySet<string> = new Set([
  "FAMILY_NOT_FOUND",
  "FAMILY_FULL",
  "MEMBER_REMOVED",
  "RECOVERY_NOT_MEMBER",
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
  /** True while an earlier 401 wave's re-verification prompt is pending, so the silent join is
   *  skipped. See docs/architecture.md → 認證更新與冷卻. */
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
 *  - family-gone codes   → clear local family data.
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

    const result = await deps.request<{ token?: unknown; expiresAt?: unknown }>(
      "/api/auth/refresh",
      { method: "POST", body: JSON.stringify({ userId, familyId }) },
      true,
    );

    // A token or expiry in the wrong shape counts as not issued (docs/architecture.md →
    // 伺服器回傳資料的檢查): a bad token takes the failure branch below.
    const token = result.data?.token;
    if (isAuthToken(token)) {
      deps.setAuthToken(token);
      const storageUpdate: Record<string, unknown> = {
        [AUTH_TOKEN_KEY]: token,
      };
      const expiresAt = result.data?.expiresAt;
      if (isExpiresAt(expiresAt)) {
        storageUpdate[TOKEN_EXPIRES_AT_KEY] = expiresAt;
      }
      await browser.storage.local.set(storageUpdate);
      await clearRecoveryCooldown();
      return { refreshed: true };
    }

    // Refresh failed — attempt staged recovery via joinFamily
    deps.setAuthToken(null);
    await browser.storage.local.remove([AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY]);

    // No silent join while a re-verification prompt is pending, nor during the user's own leave /
    // deletion (#263). See docs/architecture.md → 背景自動復原的防護 and → 認證更新與冷卻.
    if (deps.isReauthPending() || (await isSelfDepartureActive())) {
      return { refreshed: false };
    }

    // An active 429 cooldown skips the auto-join (data kept) and reports the rate-limit state for a
    // friendly message. See docs/architecture.md → 背景自動復原的防護.
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

    // 429 (only the per-IP tier can fire without a secret): set a cooldown and do NOT prompt
    // verification — a verified retry hits the same window. docs/architecture.md → 認證更新與冷卻.
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

/**
 * Clear local + synced family data, then drop this device's family-scoped API
 * endpoint choice.
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
export async function clearFamilyStorage(): Promise<void> {
  await browser.storage.local.remove([FAMILY_ID_KEY]);
  try {
    await browser.storage.sync.remove([FAMILY_ID_KEY]);
  } catch {
    // sync storage may not be available in all contexts
  }
  await resetFamilyEndpointChoice();
}

/** Clear the family data, then hand the refresh caller its notification. */
async function clearFamilyAndNotify(
  deps: RefreshDeps,
  errorCode: string,
): Promise<void> {
  await clearFamilyStorage();
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

  // Omit displayName so the backend keeps the member's chosen name; `recovery`
  // lets it refuse a user no longer listed (409 RECOVERY_NOT_MEMBER).
  const joinBody = { userId, recovery: BoolFlag.TRUE };

  const joinResult = await deps.request<{
    familyId: string;
    ownerId: string;
    members: Array<{ userId: string; displayName: string }>;
    maxMembers: number;
    createdAt: string;
    authToken?: unknown;
    expiresAt?: unknown;
  }>(
    `/api/family/${familyId}/join`,
    {
      method: "POST",
      body: JSON.stringify(joinBody),
    },
    true,
  );

  // Same rule as the refresh above: a token in the wrong shape is a failed recovery.
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
