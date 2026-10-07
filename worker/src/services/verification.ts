import type { Context, TypedResponse } from "hono";
import { type Env, isDevMode } from "../utils/env";
import {
  kvKeys,
  VERIFY_MAX_FAILURES,
  VERIFY_LOCKOUT_MS,
  VERIFY_FAIL_TTL_SECONDS,
  type VerifyRecord,
  type VerifyFailRecord,
  type OtpRecord,
} from "../kv/schema";
import { VERIFY_SECRET_MAX_LENGTH } from "../utils/validation";
import {
  chargePerUserRateLimit,
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
  type PerUserRateLimitReading,
  type PerUserRateLimitVerdict,
} from "../middleware/rateLimit";
import { jsonError, type ErrorBody } from "../utils/errors";
import { hashSecret, timingSafeEqual } from "../utils/crypto";

/** True while the CALLER is locked out (caller-scoped `verifyfail:{userId}:{callerKey}`, never the target
 *  account). Narrows `lockedUntil` to a number so callers derive the back-off without a null check. */
function isLockedOut(
  record: VerifyFailRecord | null,
): record is VerifyFailRecord & { lockedUntil: number } {
  if (!record?.lockedUntil) return false;
  return Date.now() < record.lockedUntil;
}

/** Remaining lockout time in whole seconds, rounded up (minimum 1). */
function lockoutRetryAfterSeconds(lockedUntil: number): number {
  return Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
}

/** Error descriptor returned by {@link validateVerification} on failure. */
export type VerificationError =
  | {
      /** `VERIFICATION_LOCKED`: this caller burned its failure budget. `RATE_LIMITED`: a WRONG guess with the account's
       *  ceiling spent — same shape as the rate-limit middleware's 429; never a correct secret. */
      code: "VERIFICATION_LOCKED" | "RATE_LIMITED";
      message: string;
      status: 429;
      /** Remaining back-off seconds — required on every 429, absent elsewhere. */
      retryAfter: number;
    }
  | {
      code: "VERIFICATION_REQUIRED" | "VERIFICATION_FAILED";
      message: string;
      status: 403;
    };

/** Outcome of a verification check. */
export type VerificationResult =
  { valid: true } | { valid: false; error: VerificationError };

/**
 * Render a {@link VerificationError} as the standard JSON error envelope.
 *
 * Shared by every caller of {@link validateVerification} (family create, family
 * join, auth lookup) so all of them emit the exact same codes and statuses.
 * `retryAfter` is carried by the 429 variants only; `jsonError` omits both the
 * body field and the `Retry-After` header when it is undefined.
 */
export function verificationErrorResponse(
  c: Context<{ Bindings: Env }>,
  error: VerificationError,
): Response & TypedResponse<ErrorBody, 403 | 429, "json"> {
  const retryAfter = error.status === 429 ? error.retryAfter : undefined;
  return jsonError(c, error.status, error.code, error.message, { retryAfter });
}

/**
 * 400 response for a `verifySecret` field that is present but malformed — not a
 * string, or longer than {@link VERIFY_SECRET_MAX_LENGTH} (see
 * `sanitizeVerifySecret`).
 *
 * Shared by every entry point of the gate (family create, family join, auth
 * lookup) so one malformed body cannot produce three different statuses. The
 * check belongs to the handlers, before the gate: a value that is not a secret
 * at all is a request-format error, not a failed verification, so it must never
 * be charged against the caller's failure budget or the account's ceiling.
 */
export function verifySecretFormatResponse(
  c: Context<{ Bindings: Env }>,
): Response & TypedResponse<ErrorBody, 400, "json"> {
  return jsonError(
    c,
    400,
    "INVALID_VERIFY_SECRET",
    `verifySecret must be a string of ${VERIFY_SECRET_MAX_LENGTH} characters or fewer`,
  );
}

/**
 * Whether the user has an active verification method configured — i.e. a
 * `verify:{userId}` record exists and its `method` is not `"none"`.
 *
 * For callers that must *report* the requirement (auth lookup) rather than
 * attempt a check. Performs exactly one KV read and never writes.
 *
 * NOT an exact inverse of {@link validateVerification}'s pass-through set:
 * that function ALSO passes through a corrupted pin/pattern record (`method`
 * says pin/pattern but `hash`/`salt` are null — see {@link matchesSecret}),
 * which this probe reports as "configured". The mismatch is deliberate and
 * errs closed: such an account is asked for a secret it can never fail, one
 * extra round-trip, instead of having its membership disclosed unprompted.
 * Detecting corruption here would require duplicating the hash/salt inspection
 * for a state that `PUT /:id/verify` cannot produce.
 */
export async function isVerificationConfigured(
  kv: KVNamespace,
  userId: string,
): Promise<boolean> {
  const record = await kv.get<VerifyRecord>(kvKeys.verify(userId), "json");
  return record !== null && record.method !== "none";
}

/** Compare a secret with the verify record; `null` = corrupted pin/pattern (no hash/salt) ⇒ "not configured".
 *  `consumeOtp` decides whether a `code` match deletes the OTP; read-only checks pass `false`. */
async function matchesSecret(
  kv: KVNamespace,
  userId: string,
  record: VerifyRecord,
  secret: string,
  consumeOtp: boolean,
): Promise<boolean | null> {
  if (record.method === "pin" || record.method === "pattern") {
    if (!record.hash || !record.salt) return null;
    const inputHash = await hashSecret(record.salt, secret);
    return timingSafeEqual(inputHash, record.hash);
  }

  if (record.method === "code") {
    // Validate OTP — lengths must match for a meaningful constant-time compare
    const otpRecord = await kv.get<OtpRecord>(kvKeys.otp(userId), "json");
    if (
      otpRecord &&
      secret.length === otpRecord.code.length &&
      timingSafeEqual(otpRecord.code, secret)
    ) {
      // Delete OTP after successful use (one-time), unless the caller asked to
      // leave it intact for the follow-up request that actually spends it.
      if (consumeOtp) {
        await kv.delete(kvKeys.otp(userId));
      }
      return true;
    }
  }

  return false;
}

/** Charge one failure to the caller-scoped record, locking out at VERIFY_MAX_FAILURES. Side effect:
 *  writes `verifyfail:{userId}:{callerKey}` with a TTL; never touches `verify:{userId}`. */
async function chargeFailure(
  kv: KVNamespace,
  failKey: string,
  existing: VerifyFailRecord | null,
): Promise<void> {
  const next: VerifyFailRecord = {
    failCount: (existing?.failCount ?? 0) + 1,
    lockedUntil: null,
    // An existing streak keeps its start, a fresh one starts now; kept through the lockout reset
    // below (same streak until TTL expiry or clear/void — see VERIFY_LOCKOUT_MS).
    startedAt: existing?.startedAt ?? Date.now(),
  };
  if (next.failCount >= VERIFY_MAX_FAILURES) {
    next.lockedUntil = Date.now() + VERIFY_LOCKOUT_MS;
    next.failCount = 0; // Reset count after lockout
  }
  await kv.put(failKey, JSON.stringify(next), {
    expirationTtl: VERIFY_FAIL_TTL_SECONDS,
  });
}

/** Void = the streak began before the owner's last secret change: no lockout, no carried `failCount`. A missing
 *  field never voids; pure, re-derived per read. Owner-only lever: docs/architecture.md → 安全措施. */
function isFailStreakVoid(
  verifyRecord: VerifyRecord,
  failRecord: VerifyFailRecord | null,
): boolean {
  if (!failRecord) return false;
  if (verifyRecord.secretUpdatedAt === undefined) return false;
  if (failRecord.startedAt === undefined) return false;
  return failRecord.startedAt < verifyRecord.secretUpdatedAt;
}

/** Counter scope for the per-userId verification attempt ceiling. */
export const VERIFY_ATTEMPT_SCOPE = "verify";
/** Max FAILED verification attempts per target userId per window, all callers summed. */
export const VERIFY_ATTEMPT_MAX = 10;
/** Window for {@link VERIFY_ATTEMPT_MAX}: 1 hour, in seconds. */
export const VERIFY_ATTEMPT_WINDOW_SECONDS = 3600;

/** Read the account's attempt ceiling without charging (`null` under DEV_MODE) via the shared `peekPerUserRateLimit`.
 *  Only {@link chargeWrongGuess} calls it, AFTER a wrong comparison: docs/architecture.md → 安全措施. */
async function peekAttemptCeiling(
  env: Env,
  userId: string,
): Promise<PerUserRateLimitReading | null> {
  if (isDevMode(env)) return null;

  return peekPerUserRateLimit(env.KV, {
    userId,
    scope: VERIFY_ATTEMPT_SCOPE,
    max: VERIFY_ATTEMPT_MAX,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
}

/** Writes `ratelimit:user:verify:{userId}:{bucket}` only — no-op under DEV_MODE or with the window spent (a refused
 *  attempt must not extend it). The caller's streak is a different key ({@link chargeFailure}). */
async function chargeFailedAttempt(
  kv: KVNamespace,
  reading: PerUserRateLimitReading | null,
): Promise<void> {
  if (!reading || reading.verdict.limited) return;
  await chargePerUserRateLimit(kv, reading);
}

/** Charge a wrong guess to both brakes; `limited` ⇒ 429 `RATE_LIMITED`, else 403 `VERIFICATION_FAILED`. Two
 *  DIFFERENT keys, so one write per key holds: .claude/rules/backend.md → Service, middleware and KV invariants. */
async function chargeWrongGuess(
  env: Env,
  userId: string,
  failKey: string,
  failRecord: VerifyFailRecord | null,
): Promise<PerUserRateLimitVerdict> {
  const reading = await peekAttemptCeiling(env, userId);
  await Promise.all([
    chargeFailedAttempt(env.KV, reading),
    chargeFailure(env.KV, failKey, failRecord),
  ]);
  return reading?.verdict ?? { limited: false };
}

/**
 * Validate a verification secret against the stored `verify:{userId}` record.
 *
 * The shared gate for every public endpoint that mints a token for, or reveals
 * data bound to, an email-derived userId: `POST /api/family` (create),
 * `POST /api/family/:id/join`, and `POST /api/auth/lookup`. Accounts with no
 * `verify:{userId}` record (or `method: "none"`) pass through unchanged.
 *
 * Two independent brakes, deliberately keyed differently:
 *
 * 1. **Lockout — keyed on the CALLER** (`opts.callerKey`, normally the
 *    Cloudflare-supplied client IP, IPv6 bucketed per /64), in a TTL-backed
 *    `verifyfail:{userId}:{callerKey}` entry. Only the caller who submits wrong
 *    secrets gets locked, so a stranger can never lock the account owner out of
 *    PWA login.
 * 2. **Attempt ceiling — keyed on the TARGET userId** (`ratelimit:user:verify:…`,
 *    {@link VERIFY_ATTEMPT_MAX} per {@link VERIFY_ATTEMPT_WINDOW_SECONDS}),
 *    counted here rather than in the handlers so no current or future caller of
 *    this gate can forget it. Without it the caller-scoped lockout leaves no
 *    global bound at all: the shortest allowed pattern has only 9×8×7×6 = 3,024
 *    combinations, so ~605 rotated /64 prefixes — well inside a single /48
 *    allocation — would exhaust the space with 5 tries each. The counter is
 *    shared with the rate-limit middleware via `peekPerUserRateLimit` /
 *    `chargePerUserRateLimit`.
 *
 * Brake 2 only ever measures a WRONG guess. The secret is compared FIRST; the
 * ceiling is read and charged solely on the failure branch. Consequences:
 *
 * - A CORRECT secret is admitted regardless of the ceiling, and charges nothing.
 *   The account owner can always get in, even at a moment when the window is
 *   fully spent.
 * - A request with no secret (`VERIFICATION_REQUIRED`), a malformed one
 *   (rejected earlier, at the handler), and an account with nothing configured
 *   all cost nothing either — probing cannot burn the budget.
 * - A wrong guess made while the window is already spent is refused with
 *   `RATE_LIMITED` instead of `VERIFICATION_FAILED`, and does not extend the
 *   window.
 *
 * The brute-force bound is unchanged by any of this: every guess an attacker
 * makes is wrong by definition, so {@link VERIFY_ATTEMPT_MAX} failures per
 * window still close the account to guessing.
 *
 * RESIDUAL RISK (bounded, and no longer owner-facing): brake 2 is keyed on the
 * TARGET userId, so a third party can still spend the window with wrong guesses.
 * What that buys them is only "no further GUESSING against this account until
 * the window rolls" — it does NOT keep the owner out, because a correct secret
 * is never measured against the ceiling. The counter is therefore a lever
 * against attackers, not against the account it protects. This is exactly
 * because it is charge-on-failure: a charge-EVERY-request counter keyed on the
 * target userId WOULD be owner-facing, since a third party could exhaust it with
 * requests that never even carry a secret. The join endpoint used to have such a
 * standalone per-userId counter (scope `"join"`); it was removed precisely
 * because it was charge-every-request (owner-facing) and redundant with this
 * ceiling, which now stands as the sole per-userId brake protecting join. This
 * ceiling does not contradict the caller-scoped lockout rule: that rule governs
 * who gets *locked*, not whether a global attempt ceiling may exist.
 *
 * Order of evaluation, and what each outcome costs (first match wins):
 *
 * | Situation                       | Result                    | KV writes           |
 * | ------------------------------- | ------------------------- | ------------------- |
 * | nothing configured / corrupted  | valid                     | none                |
 * | locked caller                   | 429 VERIFICATION_LOCKED   | none                |
 * | no secret supplied              | 403 VERIFICATION_REQUIRED | none                |
 * | correct secret                  | valid                     | delete failKey¹     |
 * | wrong secret, ceiling available | 403 VERIFICATION_FAILED   | ceiling + failKey   |
 * | wrong secret, ceiling spent     | 429 RATE_LIMITED          | failKey only²       |
 *
 * ¹ only when this caller has a failure record (or a void leftover) to clear.
 * ² the spent counter is not written again — a refused attempt must not extend
 *   the window.
 *
 * Under `DEV_MODE=1` the ceiling is skipped, exactly like every other limiter
 * (per-IP and per-userId), leaving lockout as the only brake.
 *
 * `opts.consumeOtp` (default `true`) decides whether a matching `code` secret is
 * spent. Read-only disclosure decisions pass `false`: `POST /api/auth/lookup`
 * is followed by a create/join carrying the SAME secret, and consuming the OTP
 * on the lookup would make that second call fail — and be charged as a failure.
 * Not consuming on a read grants nothing: the OTP still dies with its own 300s
 * TTL, and the caller already holds it.
 *
 * A failure record whose streak began before the account owner last changed the
 * secret is void and is ignored for this request. Voiding is an in-memory
 * verdict ({@link isFailStreakVoid}); the stored entry is removed only on paths
 * that would otherwise leave it behind — see the per-path notes below. Cleanup
 * always targets this caller's own key, never a KV.list scan.
 *
 * At most ONE write happens to `verifyfail:{userId}:{callerKey}` per request:
 * Cloudflare KV allows only one write per second per key, so a delete followed
 * by a put in the same request could silently drop the newly charged failure.
 *
 * This function never writes `verify:{userId}`.
 *
 * Returns: { valid: true } or error response.
 */
export async function validateVerification(
  env: Env,
  userId: string,
  secret: string | undefined,
  opts: { callerKey: string; consumeOtp?: boolean },
): Promise<VerificationResult> {
  const kv = env.KV;
  const record = await kv.get<VerifyRecord>(kvKeys.verify(userId), "json");

  // No verification set or method is 'none' — allow through
  if (!record || record.method === "none") {
    return { valid: true };
  }

  const failKey = kvKeys.verifyFail(userId, opts.callerKey);
  const storedFail = await kv.get<VerifyFailRecord>(failKey, "json");

  // A streak predating the current secret is a clean slate, decided in memory only: a path that
  // writes the same key must not delete it first.
  const voided = isFailStreakVoid(record, storedFail);
  const failRecord = voided ? null : storedFail;

  // Check lockout for this caller
  if (isLockedOut(failRecord)) {
    return {
      valid: false,
      error: {
        code: "VERIFICATION_LOCKED",
        message: "驗證已鎖定，請稍後再試",
        status: 429,
        retryAfter: lockoutRetryAfterSeconds(failRecord.lockedUntil),
      },
    };
  }

  // No secret: no attempt, nothing charged, no KV write — a void leftover stays inert until its
  // TTL or the next request overwrites / clears it.
  if (!secret || typeof secret !== "string") {
    return {
      valid: false,
      error: {
        code: "VERIFICATION_REQUIRED",
        message: "此帳號需要驗證才能登入",
        status: 403,
      },
    };
  }

  // Compare FIRST: the target-keyed ceiling must never refuse a correct secret, or any third party
  // could lock the owner out (Inv-6). See docs/architecture.md → 安全措施.
  const matched = await matchesSecret(
    kv,
    userId,
    record,
    secret,
    opts.consumeOtp ?? true,
  );

  // Corrupted record — treat as no verification
  if (matched === null) {
    return { valid: true };
  }

  if (!matched) {
    // The only path touching the attempt ceiling. `chargeFailure` overwrites the whole entry, so
    // a void leftover is replaced here, not deleted first.
    const ceiling = await chargeWrongGuess(env, userId, failKey, failRecord);
    if (ceiling.limited) {
      // Hourly guessing budget spent: report the ceiling, so the caller learns to wait, not guess.
      return {
        valid: false,
        error: {
          code: "RATE_LIMITED",
          message: RATE_LIMITED_MESSAGE,
          status: 429,
          retryAfter: ceiling.retryAfter,
        },
      };
    }
    return {
      valid: false,
      error: { code: "VERIFICATION_FAILED", message: "驗證失敗", status: 403 },
    };
  }

  // Success — clear this caller's failure history, including a void leftover
  // that no later write will replace.
  if (failRecord || voided) {
    await kv.delete(failKey);
  }

  return { valid: true };
}
