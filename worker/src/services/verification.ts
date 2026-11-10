import type { Context, TypedResponse } from "hono";
import { type Env, getVerifyPepper } from "../utils/env";
import {
  kvKeys,
  VERIFY_HASH_VERSION_PEPPER,
  VERIFY_MAX_FAILURES,
  VERIFY_LOCKOUT_MS,
  VERIFY_FAIL_TTL_SECONDS,
  type AuthRecord,
  type VerifyRecord,
  type VerifyFailRecord,
  type OtpRecord,
} from "../kv/schema";
import { VERIFY_SECRET_MAX_LENGTH } from "../utils/validation";
import {
  checkPerUserBurstLimit,
  getCallerIp,
  RATE_LIMITED_MESSAGE,
} from "../middleware/rateLimit";
import {
  releaseCorrectGuess,
  reserveAttempt,
  resetAttemptBudget,
  settleWrongGuess,
} from "./attemptBudget";
import { jsonError, type ErrorBody } from "../utils/errors";
import { getAccountDeletingMark } from "../kv/accountDeleting";
import { deleteVerifyRecord, putVerifyRecord } from "../kv/verify";
import { stepUpBudgetBucket } from "./authRecord";
import {
  hashSecret,
  hashSecretWithPepper,
  pepperFingerprint,
  timingSafeEqual,
} from "../utils/crypto";

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
      /** `VERIFICATION_LOCKED`: this caller burned its failure budget. `RATE_LIMITED`: the account's per-minute limit or
       *  hourly budget is spent, whatever the secret — same shape as the rate-limit middleware's 429. */
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
    }
  | {
      /** A pin/pattern record this Worker cannot check: v2 with the pepper missing or different, or an
       *  unknown hash version. Nothing is charged or written; the operator must restore the pepper. */
      code: "VERIFY_UNAVAILABLE";
      message: string;
      status: 503;
    };

/** Outcome of a verification check; a pass carries the `verify:{userId}` record it was decided on. */
export type VerificationResult =
  | { valid: true; record: VerifyRecord | null }
  | { valid: false; error: VerificationError };

/** The 403 asking for the account's secret — the gate's no-secret answer, reused by join's #378 refusals. */
export const VERIFICATION_REQUIRED_ERROR: VerificationError = {
  code: "VERIFICATION_REQUIRED",
  message: "此帳號需要驗證才能登入",
  status: 403,
};

/** The 429 of a spent per-minute limit or hourly budget, identical for a correct and a wrong secret. */
function attemptLimitError(retryAfter: number): VerificationError {
  return {
    code: "RATE_LIMITED",
    message: RATE_LIMITED_MESSAGE,
    status: 429,
    retryAfter,
  };
}

/** The 503 for a record whose hash scheme this Worker cannot check (see {@link unverifiableHashReason}). */
const VERIFY_UNAVAILABLE_ERROR: VerificationError = {
  code: "VERIFY_UNAVAILABLE",
  message: "伺服器的驗證設定不完整，請聯絡管理者",
  status: 503,
};

/**
 * True when a passed verification was decided on a verify record older than the
 * one `auth`'s token rotation was written for (`AuthRecord.secretAt`, #378): a
 * stale colo compared a superseded secret, or saw no secret at all, so the join
 * must not hand out a token and `POST /verify/prompted` must not write the record
 * back. `auth` without `secretAt` never trips it. See
 * docs/architecture.md → PWA 登入驗證機制.
 */
export function passedAgainstStaleVerifyRecord(
  auth: AuthRecord | null,
  record: VerifyRecord | null,
): boolean {
  const secretAt = auth?.secretAt;
  if (typeof secretAt !== "number") return false;
  const recordAt = record?.secretUpdatedAt;
  return typeof recordAt !== "number" || secretAt > recordAt;
}

/**
 * Render a {@link VerificationError} as the standard JSON error envelope.
 *
 * Shared by every caller of {@link validateVerification} (family create, family
 * join, auth lookup, and the {@link enforceCurrentSecret} step-up) so all of them
 * emit the exact same codes and statuses (the step-up's optional `requiredMessage`
 * only rewords its no-secret 403 on self-leave and ownership transfer).
 * `retryAfter` is carried by the 429 variants only; `jsonError` omits both the
 * body field and the `Retry-After` header when it is undefined.
 */
export function verificationErrorResponse(
  c: Context<{ Bindings: Env }>,
  error: VerificationError,
): Response & TypedResponse<ErrorBody, 403 | 429 | 503, "json"> {
  const retryAfter = error.status === 429 ? error.retryAfter : undefined;
  return jsonError(c, error.status, error.code, error.message, { retryAfter });
}

/**
 * 400 response for a secret field that is present but malformed — not a
 * string, or longer than {@link VERIFY_SECRET_MAX_LENGTH} (see
 * `sanitizeVerifySecret`).
 *
 * Shared by every entry point of the gate (family create, family join, auth
 * lookup) so one malformed body cannot produce three different statuses, and by
 * the step-up callers of {@link enforceCurrentSecret} (`PUT /api/user/:id/verify`,
 * `DELETE /api/user/:id`, self-leave through `DELETE /api/family/:id/member/:uid`
 * and `PUT /api/family/:id/transfer`), which pass `field = "currentSecret"`; the code stays
 * `INVALID_VERIFY_SECRET`. The check belongs to the handlers, before the gate: a
 * value that is not a secret at all is a request-format error, not a failed
 * verification, so it must never be charged against the caller's failure budget
 * or the account's ceiling.
 */
export function verifySecretFormatResponse(
  c: Context<{ Bindings: Env }>,
  field = "verifySecret",
): Response & TypedResponse<ErrorBody, 400, "json"> {
  return jsonError(
    c,
    400,
    "INVALID_VERIFY_SECRET",
    `${field} must be a string of ${VERIFY_SECRET_MAX_LENGTH} characters or fewer`,
  );
}

/**
 * Whether the user has an active verification method configured — i.e. a
 * `verify:{userId}` record exists and its `method` is not `"none"`.
 *
 * For callers that must *report* the requirement (auth lookup) rather than
 * attempt a check. Pure: the caller reads `verify:{userId}` once and keeps the
 * record for the stale-record check ({@link passedAgainstStaleVerifyRecord}).
 *
 * NOT an exact inverse of {@link validateVerification}'s pass-through set:
 * that function ALSO passes through a corrupted pin/pattern record (`method`
 * says pin/pattern but `hash`/`salt` are null — see {@link isCorruptedSecretRecord}),
 * which this probe reports as "configured". The mismatch is deliberate and
 * errs closed: such an account is asked for a secret it can never fail, one
 * extra round-trip, instead of having its membership disclosed unprompted.
 * Detecting corruption here would require duplicating the hash/salt inspection
 * for a state that `PUT /:id/verify` cannot produce.
 */
export function isVerificationConfigured(record: VerifyRecord | null): boolean {
  return record !== null && record.method !== "none";
}

/** Fail-closed hash-scheme check for a pin/pattern record: the log event naming why this Worker cannot check
 *  it (⇒ 503 VERIFY_UNAVAILABLE), or `null` when it can. v1 (absent / 1) always can. */
async function unverifiableHashReason(
  record: VerifyRecord,
  pepper: string | null,
): Promise<string | null> {
  if (record.method !== "pin" && record.method !== "pattern") return null;
  if (record.version === undefined || record.version === 1) return null;
  if (record.version !== VERIFY_HASH_VERSION_PEPPER) {
    return "VERIFY_HASH_VERSION_UNSUPPORTED";
  }
  if (pepper === null) return "VERIFY_PEPPER_MISSING";
  if (record.pepperId !== (await pepperFingerprint(pepper))) {
    return "VERIFY_PEPPER_MISMATCH";
  }
  return null;
}

/** Hash `secret` under the record's scheme: v2 ⇒ HMAC with the pepper, else v1 SHA-256. Only reached after
 *  {@link unverifiableHashReason} returned `null`, so a v2 record always has its pepper here. */
async function hashForRecord(
  record: VerifyRecord,
  salt: string,
  secret: string,
  pepper: string | null,
): Promise<string> {
  if (record.version !== VERIFY_HASH_VERSION_PEPPER) {
    return hashSecret(salt, secret);
  }
  if (pepper === null) throw new Error("VERIFY_PEPPER_MISSING");
  return hashSecretWithPepper(pepper, salt, secret);
}

/** A pin/pattern record with no hash or salt: nothing to compare against, so the gate treats it as "not configured". */
function isCorruptedSecretRecord(record: VerifyRecord): boolean {
  if (record.method !== "pin" && record.method !== "pattern") return false;
  return !record.hash || !record.salt;
}

/** Compare a secret with the verify record. A corrupted record never matches: the gate passed it earlier.
 *  `consumeOtp` decides whether a `code` match deletes the OTP; read-only checks pass `false`. */
async function matchesSecret(
  kv: KVNamespace,
  userId: string,
  record: VerifyRecord,
  secret: string,
  opts: { consumeOtp: boolean; pepper: string | null },
): Promise<boolean> {
  if (record.method === "pin" || record.method === "pattern") {
    if (!record.hash || !record.salt) return false;
    const inputHash = await hashForRecord(
      record,
      record.salt,
      secret,
      opts.pepper,
    );
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
      if (opts.consumeOtp) {
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

/** Counter scope of the login attempt budget (lookup / create / join). */
export const VERIFY_ATTEMPT_SCOPE = "verify";
/** Counter scope of the current-secret attempt budget ({@link enforceCurrentSecret}). */
export const VERIFY_STEP_UP_ATTEMPT_SCOPE = "verify-stepup";
/** Binding key scope of the login per-minute limit; never written to KV. */
export const VERIFY_BURST_SCOPE = "verify-burst";
/** Binding key scope of the current-secret per-minute limit; never written to KV. */
export const VERIFY_STEP_UP_BURST_SCOPE = "verify-stepup-burst";
/** Wrong guesses per target userId per window on the login budget, all callers summed. Once spent, every secret is refused. */
export const VERIFY_ATTEMPT_MAX = 10;
/** Wrong guesses per window on ONE step-up budget (one per unmarked token, one shared by the rest). Once spent, every secret is refused. */
export const VERIFY_STEP_UP_ATTEMPT_MAX = 5;
/** Window for both attempt budgets: 1 hour, in seconds. */
export const VERIFY_ATTEMPT_WINDOW_SECONDS = 3600;
/** Secret-bearing requests per budget subject per window, right or wrong; served by `RATE_LIMIT_10_PER_MIN`. */
export const VERIFY_BURST_MAX = 10;
/** Window for {@link VERIFY_BURST_MAX}: 1 minute, in seconds. */
export const VERIFY_BURST_WINDOW_SECONDS = 60;

/** The hourly budget and per-minute limit a gate call is measured against. `subject` replaces the userId in
 *  both counter keys; absent ⇒ the userId. */
interface VerifyAttemptBudget {
  ceilingScope: string;
  burstScope: string;
  max: number;
  subject?: string;
}

const LOGIN_ATTEMPT_BUDGET: VerifyAttemptBudget = {
  ceilingScope: VERIFY_ATTEMPT_SCOPE,
  burstScope: VERIFY_BURST_SCOPE,
  max: VERIFY_ATTEMPT_MAX,
};

/** One token's step-up budget; `bucket` comes from `stepUpBudgetBucket` (`services/authRecord.ts`). */
function stepUpBudgetFor(userId: string, bucket: string): VerifyAttemptBudget {
  return {
    ceilingScope: VERIFY_STEP_UP_ATTEMPT_SCOPE,
    burstScope: VERIFY_STEP_UP_BURST_SCOPE,
    max: VERIFY_STEP_UP_ATTEMPT_MAX,
    subject: `${userId}:${bucket}`,
  };
}

/**
 * Clear the current window of the login attempt budget, after the owner saved new
 * verification settings: guesses against the old secret no longer mean anything.
 * Clears both the Durable Object (when bound, not DEV_MODE) and the KV fallback
 * counter (`resetAttemptBudget`). The step-up budget is deliberately left alone.
 *
 * Fail-open: the settings are already saved, so an error only logs the event name
 * (a KV message may echo the key, which carries the userId, #357) and the count
 * stays until its window ends. See docs/architecture.md → 安全措施.
 */
export async function resetLoginAttemptCeiling(
  env: Env,
  userId: string,
): Promise<void> {
  try {
    await resetAttemptBudget(env, {
      subject: userId,
      scope: VERIFY_ATTEMPT_SCOPE,
      windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
    });
  } catch {
    console.error("VERIFY_CEILING_RESET_FAILED");
  }
}

/**
 * Validate a verification secret against the stored `verify:{userId}` record.
 *
 * The shared gate for every public endpoint that mints a token for, or reveals
 * data bound to, an email-derived userId: `POST /api/family` (create),
 * `POST /api/family/:id/join`, and `POST /api/auth/lookup` — and, through
 * {@link enforceCurrentSecret}, the step-up of `PUT /api/user/:id/verify`,
 * `DELETE /api/user/:id`, self-leave (`DELETE /api/family/:id/member/:uid` with
 * `uid` = caller) and `PUT /api/family/:id/transfer`. Accounts with no `verify:{userId}` record (or
 * `method: "none"`) pass through unchanged.
 *
 * Three independent brakes, deliberately keyed differently:
 *
 * 1. **Lockout — keyed on the CALLER** (`opts.callerKey`, normally the
 *    Cloudflare-supplied client IP, IPv6 bucketed per /64), in a TTL-backed
 *    `verifyfail:{userId}:{callerKey}` entry. A caller's lockout never touches
 *    another caller.
 * 2. **Per-minute limit — keyed on the TARGET userId** (`opts.budget.subject` on the
 *    step-up), {@link VERIFY_BURST_MAX} per {@link VERIFY_BURST_WINDOW_SECONDS} on the
 *    native binding, never KV (`checkPerUserBurstLimit`). It counts every
 *    secret-bearing request, right or wrong, and is skipped when the deployment has
 *    no binding or the binding fails.
 * 3. **Hourly attempt budget — keyed the same way** (`opts.budget.max` per
 *    {@link VERIFY_ATTEMPT_WINDOW_SECONDS}; {@link VERIFY_ATTEMPT_MAX} on login), held
 *    by the `ATTEMPT_BUDGET` Durable Object with the KV counter as fallback
 *    (`services/attemptBudget.ts`). Every compared secret reserves a slot first; a
 *    correct one gives it back, so in effect only wrong guesses spend it. Without a
 *    per-account brake the caller-scoped lockout leaves no account-wide bound, and
 *    the shortest allowed pattern has only 9×8×7×6 = 3,024 combinations.
 *
 * Brakes 2 and 3 live here rather than in the handlers so no current or future
 * caller of this gate can forget them. Both are consulted BEFORE the comparison,
 * so a correct and a wrong answer take the same path once either is spent. A
 * refused request calls no `matchesSecret`, reads no `otp:{userId}`, never hashes
 * the submitted secret and writes nothing. Consequences:
 *
 * - With either limit spent, a CORRECT secret gets the same `429 RATE_LIMITED` as
 *   a wrong one. A correct secret's slot is refunded; while it is reserved a
 *   parallel request may be refused, and a failed refund keeps it spent until the
 *   window ends.
 * - A request with no secret (`VERIFICATION_REQUIRED`), a malformed one (rejected
 *   earlier, at the handler), and an account with nothing configured cost neither
 *   limit, so probing and silent recovery joins cannot spend them.
 * - With the Durable Object the hourly budget is a hard bound: in one window no
 *   more than `max` requests reach the comparison, however many arrive at once.
 *   An overloaded object answers `429 RATE_LIMITED` (`retryAfter` 60). Without the
 *   binding, or when the object fails, the KV fallback holds for sequential
 *   traffic within one Cloudflare location only, and the per-minute limit is never
 *   a hard bound (docs/architecture.md → 已接受的殘餘風險).
 *
 * ACCEPTED TRADE-OFF: on login, brakes 2 and 3 are keyed on the TARGET userId, so a
 * third party can spend them with wrong answers and block the owner's new-device
 * login, window after window. They gain no data, and an account takeover is worse. A
 * device whose login is still valid keeps working, an unmarked one can mint a QR Code
 * that needs no secret, and an operator can issue a rescue link, which skips this gate
 * (worker/DEPLOY.md → 救援連結). Requests with no secret never count, which is what
 * separates these limits from a charge-EVERY-request counter (join's removed `"join"`
 * scope). The step-up's budgets are per token ({@link enforceCurrentSecret}). Rule:
 * .claude/rules/security-ux-invariants.md → Invariant 6.
 *
 * Order of evaluation, and what each outcome costs (first match wins):
 *
 * | Situation                       | Result                    | KV writes          |
 * | ------------------------------- | ------------------------- | ------------------ |
 * | nothing configured              | valid                     | none               |
 * | locked caller                   | 429 VERIFICATION_LOCKED   | none               |
 * | unverifiable hash scheme²       | 503 VERIFY_UNAVAILABLE    | none               |
 * | no secret supplied              | 403 VERIFICATION_REQUIRED | none               |
 * | corrupted record (no hash/salt) | valid                     | none               |
 * | per-minute limit spent          | 429 RATE_LIMITED (60)     | none               |
 * | hourly budget spent             | 429 RATE_LIMITED (rest)³  | none               |
 * | correct secret                  | valid                     | delete failKey¹    |
 * | wrong secret                    | 403 VERIFICATION_FAILED   | failKey (+ count⁴) |
 *
 * ¹ only when this caller has a failure record (or a void leftover) to clear.
 *   A slot reserved in the Durable Object is refunded first.
 * ² a pin/pattern record of v2 with no pepper configured or a different one
 *   (`pepperId` mismatch), or of an unknown `version` — with or without a
 *   secret; logs `VERIFY_PEPPER_MISSING` / `VERIFY_PEPPER_MISMATCH` /
 *   `VERIFY_HASH_VERSION_UNSUPPORTED` (no identifiers) and charges nothing.
 *   It never falls through to the corrupted-record pass. Its pepper fingerprint
 *   does not involve the submitted secret.
 * ³ `retryAfter` = the seconds left in the window (60 while the object is overloaded).
 * ⁴ the KV counter, on the fallback only; the Durable Object counted the slot when
 *   it was reserved.
 *
 * A correct v1 secret is NOT upgraded here: the create / join / lookup handlers
 * call {@link upgradeVerifyRecordHash} after their stale-record check.
 *
 * Under `DEV_MODE=1` both limits are skipped, exactly like every other limiter
 * (per-IP and per-userId), leaving lockout as the only brake.
 *
 * `opts.budget` (default {@link LOGIN_ATTEMPT_BUDGET}) names the two scopes, the
 * hourly maximum and the string that keys both limits.
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
 * `opts.record`, when supplied (`null` included — "already looked, nothing
 * there"), is the caller's own read of `verify:{userId}` and replaces this
 * function's read — the step-up path ({@link enforceCurrentSecret}) already
 * holds it. Left `undefined`, the record is read here, as before.
 *
 * Returns: { valid: true, record } (the `verify:{userId}` record read, `null` when absent) or error response.
 */
export async function validateVerification(
  env: Env,
  userId: string,
  secret: string | undefined,
  opts: {
    callerKey: string;
    consumeOtp?: boolean;
    record?: VerifyRecord | null;
    budget?: VerifyAttemptBudget;
  },
): Promise<VerificationResult> {
  const kv = env.KV;
  const record =
    opts.record !== undefined
      ? opts.record
      : await kv.get<VerifyRecord>(kvKeys.verify(userId), "json");

  // No verification set or method is 'none' — allow through
  if (!record || record.method === "none") {
    return { valid: true, record };
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

  // Fail closed, secret or not, BEFORE the corrupted-record pass: comparing under the wrong scheme would
  // charge the owner's correct secret as a wrong guess. Log carries no identifiers (#357).
  const pepper = getVerifyPepper(env);
  const unverifiable = await unverifiableHashReason(record, pepper);
  if (unverifiable !== null) {
    console.error(unverifiable);
    return { valid: false, error: VERIFY_UNAVAILABLE_ERROR };
  }

  // No secret: no attempt, nothing charged, no KV write — a void leftover stays inert until its
  // TTL or the next request overwrites / clears it.
  if (!secret || typeof secret !== "string") {
    return { valid: false, error: VERIFICATION_REQUIRED_ERROR };
  }

  // Corrupted record — treat as no verification
  if (isCorruptedSecretRecord(record)) {
    return { valid: true, record };
  }

  // Both limits come BEFORE the comparison, so both answers take one path once either is spent
  // (Inv-6's sanctioned exception). See docs/architecture.md → 安全措施.
  const budget = opts.budget ?? LOGIN_ATTEMPT_BUDGET;
  const subject = budget.subject ?? userId;
  const burst = await checkPerUserBurstLimit(env, {
    userId: subject,
    scope: budget.burstScope,
    max: VERIFY_BURST_MAX,
    windowSec: VERIFY_BURST_WINDOW_SECONDS,
  });
  if (burst.limited) {
    return { valid: false, error: attemptLimitError(burst.retryAfter) };
  }

  // A slot is reserved before comparing; a throw from matchesSecret keeps it spent (conservative).
  const reservation = await reserveAttempt(env, {
    subject,
    scope: budget.ceilingScope,
    max: budget.max,
    windowSec: VERIFY_ATTEMPT_WINDOW_SECONDS,
  });
  if (reservation.kind === "limited") {
    return { valid: false, error: attemptLimitError(reservation.retryAfter) };
  }

  const matched = await matchesSecret(kv, userId, record, secret, {
    consumeOtp: opts.consumeOtp ?? true,
    pepper,
  });

  if (!matched) {
    // Two DIFFERENT keys, one write each: .claude/rules/backend.md → Service, middleware and KV invariants.
    // `chargeFailure` overwrites the whole entry, so a void leftover is replaced here, not deleted first.
    await Promise.all([
      settleWrongGuess(env, reservation),
      chargeFailure(kv, failKey, failRecord),
    ]);
    return {
      valid: false,
      error: { code: "VERIFICATION_FAILED", message: "驗證失敗", status: 403 },
    };
  }

  await releaseCorrectGuess(env, reservation);

  // Success — clear this caller's failure history, including a void leftover
  // that no later write will replace.
  if (failRecord || voided) {
    await kv.delete(failKey);
  }

  return { valid: true, record };
}

/** True when changing this account's verification, deleting it, leaving a family or transferring ownership needs the
 *  CURRENT secret (#396): a configured pin/pattern record. `none` / `code` / no record never do; a corrupted one does. */
function needsCurrentSecret(record: VerifyRecord | null): boolean {
  if (!isVerificationConfigured(record)) return false;
  return record?.method === "pin" || record?.method === "pattern";
}

/**
 * Step-up for an authenticated owner's sensitive write (#396): `PUT /api/user/:id/verify`,
 * `DELETE /api/user/:id`, self-leave (`DELETE /api/family/:id/member/:uid` with `uid` =
 * caller) and `PUT /api/family/:id/transfer` must present the account's CURRENT PIN /
 * pattern when one is configured. Returns `null` to proceed, else the error response to send.
 * The two family routes reach it through `enforceCallerCurrentSecret`
 * (`services/currentSecretStepUp.ts`).
 *
 * `record`, `presentedAuth` and `presentedHash` are the handler's own reads of
 * `verify:{userId}`, `auth:{userId}` and the bearer's hash (`readPresentedAuth(...)`) —
 * this function reads neither record again. `currentSecret` is `sanitizeVerifySecret()`'s
 * value, passed through unchanged: `""` means "not supplied", exactly as for
 * {@link validateVerification}.
 *
 * - Stale record ({@link passedAgainstStaleVerifyRecord}) ⇒ `403 VERIFICATION_REQUIRED`
 *   whatever its shape — absent, `none` and `code` included — checked FIRST, with no
 *   comparison, no counter charge and no KV write: this colo has not seen the owner's
 *   latest secret, so passing would let a current-token holder who lacks it switch
 *   verification off or delete the account, and comparing would charge the owner's
 *   correct new secret as a wrong guess. The client asks again; a caught-up colo passes.
 * - Not stale and no step-up needed (`none` / `code` / no record) ⇒ `null`; a supplied
 *   secret is ignored. Covers an account that never had a PIN (`auth` has no `secretAt`),
 *   one that switched PIN ⇒ `none` / `code` (that save's `secretUpdatedAt` ≥ `secretAt`)
 *   and a missing `auth:` record (TTL gap).
 * - Otherwise the login gate itself decides, on the handler's record — byte-identical
 *   responses (`403 VERIFICATION_REQUIRED` / `VERIFICATION_FAILED`, `429
 *   VERIFICATION_LOCKED` / `RATE_LIMITED` + `retryAfter`, `503 VERIFY_UNAVAILABLE`). A
 *   step-up never upgrades a v1 hash (the caller rewrites or deletes the record next).
 *   The lockout and both limits belong to the bucket `stepUpBudgetBucket` names: each
 *   listed unmarked token has its own, every other bearer shares one. They are separate
 *   from login's, so public login traffic cannot spend them, and a spent budget refuses
 *   a correct secret from that bucket only (Invariant 6); the owner's other logins, a
 *   PIN login on a new device and the rescue link stay open (worker/DEPLOY.md →
 *   使用者忘記登入驗證時).
 * - A KV error logs the event name only and rethrows a generic error (still a 500): its
 *   message may echo a key, and the step-up keys carry a token hash (#357).
 * - `requiredMessage`, when given, replaces the message of the gate's no-secret
 *   `403 VERIFICATION_REQUIRED` only — never the stale-record one above, never any other
 *   code, status or `retryAfter`. Without it every response is unchanged.
 *
 * See docs/architecture.md → 只有帳號目前的 token 能改驗證設定.
 */
export async function enforceCurrentSecret(
  c: Context<{ Bindings: Env }>,
  userId: string,
  record: VerifyRecord | null,
  currentSecret: string | undefined,
  presentedAuth: AuthRecord | null,
  presentedHash: string | null,
  requiredMessage?: string,
): Promise<
  (Response & TypedResponse<ErrorBody, 403 | 429 | 503, "json">) | null
> {
  if (passedAgainstStaleVerifyRecord(presentedAuth, record)) {
    return verificationErrorResponse(c, VERIFICATION_REQUIRED_ERROR);
  }

  if (!needsCurrentSecret(record)) return null;

  const bucket = stepUpBudgetBucket(presentedAuth, presentedHash);
  let verification: VerificationResult;
  try {
    verification = await validateVerification(c.env, userId, currentSecret, {
      callerKey: `${getCallerIp(c)}:${bucket}`,
      record,
      budget: stepUpBudgetFor(userId, bucket),
    });
  } catch {
    console.error("VERIFY_STEP_UP_FAILED");
    throw new Error("VERIFY_STEP_UP_FAILED");
  }
  if (!verification.valid) {
    return verificationErrorResponse(
      c,
      withRequiredMessage(verification.error, requiredMessage),
    );
  }
  return null;
}

/** Swap the message of the gate's no-secret 403 (the only `VERIFICATION_REQUIRED` `validateVerification`
 *  returns); every other error, and an absent `requiredMessage`, passes through unchanged. */
function withRequiredMessage(
  error: VerificationError,
  requiredMessage: string | undefined,
): VerificationError {
  if (requiredMessage === undefined || error.code !== "VERIFICATION_REQUIRED") {
    return error;
  }
  return { ...error, message: requiredMessage };
}

/**
 * Rewrite a v1 pin/pattern record as v2 (HMAC with the pepper) once its secret
 * has just been proven correct. Called ONLY by the create / join / lookup
 * handlers, after the gate passed AND `passedAgainstStaleVerifyRecord` returned
 * false — the gate itself never writes `verify:{userId}`. `record` is the one
 * the gate compared; `secret` is that same correct secret.
 *
 * A no-op unless the record is pin/pattern, v1 (`version` absent or 1), carries
 * a hash and salt, and a pepper is configured. The SAME salt is reused, and
 * `method`, `prompted` and `secretUpdatedAt` are copied unchanged: advancing
 * `secretUpdatedAt` would void live lockouts, and the stale-record check keys
 * on it.
 *
 * Fail-open: any error (KV allows one write per second per key) is logged
 * without identifiers and swallowed — a correct secret never fails because the
 * upgrade did. Races with the other `verify:` writers are accepted residuals:
 * docs/architecture.md → PWA 登入驗證機制 → 安全措施.
 */
export async function upgradeVerifyRecordHash(
  env: Env,
  userId: string,
  record: VerifyRecord,
  secret: string,
): Promise<void> {
  if (record.method !== "pin" && record.method !== "pattern") return;
  if (record.version !== undefined && record.version !== 1) return;
  if (!record.hash || !record.salt) return;
  const pepper = getVerifyPepper(env);
  if (pepper === null) return;

  try {
    const [hash, pepperId] = await Promise.all([
      hashSecretWithPepper(pepper, record.salt, secret),
      pepperFingerprint(pepper),
    ]);
    await putVerifyRecord(env.KV, userId, {
      ...record,
      hash,
      version: VERIFY_HASH_VERSION_PEPPER,
      pepperId,
    });
    // A deletion that started while this ran must not get the old secret back (#468).
    if ((await getAccountDeletingMark(env.KV, userId)) !== null) {
      await deleteVerifyRecord(env.KV, userId);
    }
  } catch {
    // Event name only: a KV error message may echo the key, which carries the userId (#357).
    console.error("VERIFY_HASH_UPGRADE_FAILED");
  }
}
