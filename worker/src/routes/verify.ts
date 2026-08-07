import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import { type Env, isDevMode } from "../utils/env";
import {
  kvKeys,
  OTP_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  VERIFY_MAX_FAILURES,
  VERIFY_LOCKOUT_MS,
  VERIFY_FAIL_TTL_SECONDS,
  type VerifyRecord,
  type VerifyFailRecord,
  type OtpRecord,
  type QrTokenRecord,
} from "../kv/schema";
import {
  isValidUserId,
  isValidVerifyMethod,
  isValidPin,
  isValidPattern,
  VERIFY_SECRET_MAX_LENGTH,
} from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import {
  chargePerUserRateLimit,
  peekPerUserRateLimit,
  RATE_LIMITED_MESSAGE,
  type PerUserRateLimitReading,
  type PerUserRateLimitVerdict,
} from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError, type ErrorBody } from "../utils/errors";
import { UserIdParam } from "../schemas/common";

export const verifyRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

/**
 * Hash a secret with a salt using SHA-256.
 * Returns hex-encoded hash string.
 */
async function hashSecret(salt: string, secret: string): Promise<string> {
  const data = new TextEncoder().encode(salt + secret);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Both strings must be the same length for meaningful comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Generate a random hex salt (16 bytes = 32 hex chars). */
function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate a 6-digit OTP code. */
function generateOtpCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const num =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 1000000).padStart(6, "0");
}

/** Build default verify record. */
function defaultVerifyRecord(): VerifyRecord {
  return {
    method: "none",
    hash: null,
    salt: null,
    prompted: 0,
  };
}

/**
 * Check if the CALLER is currently locked out. Returns true if locked.
 * Lockout is caller-scoped (`verifyfail:{userId}:{callerKey}`), never charged
 * to the target account. Narrows `lockedUntil` to a number so callers can
 * derive the remaining back-off without re-checking for null.
 */
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

// GET /:id/verify — get verification method (public, needed before login)
const getVerifyRoute = createRoute({
  method: "get",
  path: "/{id}/verify",
  tags: ["Verify"],
  summary: "Get verification method",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Verification method and prompted status"),
    400: jsonRes("Invalid user ID"),
  },
});

verifyRoutes.openapi(getVerifyRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const record = await c.env.KV.get<VerifyRecord>(
    kvKeys.verify(userId),
    "json",
  );
  const method = record?.method ?? "none";
  const prompted = record?.prompted ?? 0;

  return c.json({ data: { method, prompted } });
});

// PUT /:id/verify — set or change verification method (protected)
const putVerifyRoute = createRoute({
  method: "put",
  path: "/{id}/verify",
  tags: ["Verify"],
  summary: "Set or change verification method",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Updated verification settings"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
  },
});

verifyRoutes.openapi(putVerifyRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  let body: { method: string; secret?: string; prompted?: number } | null;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "INVALID_JSON", "Request body must be valid JSON");
  }

  if (!body || !isValidVerifyMethod(body.method)) {
    return jsonError(
      c,
      400,
      "INVALID_METHOD",
      "method must be one of: pin, pattern, code, none",
    );
  }

  const method = body.method;

  // Validate secret for pin/pattern
  if (method === "pin") {
    if (
      !body.secret ||
      typeof body.secret !== "string" ||
      !isValidPin(body.secret)
    ) {
      return jsonError(c, 400, "INVALID_SECRET", "PIN must be 6-12 digits");
    }
  } else if (method === "pattern") {
    if (
      !body.secret ||
      typeof body.secret !== "string" ||
      !isValidPattern(body.secret)
    ) {
      return jsonError(
        c,
        400,
        "INVALID_SECRET",
        "Pattern must have 4-9 unique nodes (0-8), comma-separated",
      );
    }
  }

  let hash: string | null = null;
  let salt: string | null = null;

  if ((method === "pin" || method === "pattern") && body.secret) {
    salt = generateSalt();
    hash = await hashSecret(salt, body.secret);
  }

  const existing = await c.env.KV.get<VerifyRecord>(
    kvKeys.verify(userId),
    "json",
  );

  const record: VerifyRecord = {
    method,
    hash,
    salt,
    prompted: body.prompted === 1 ? 1 : (existing?.prompted ?? 0),
    // Stamping the change voids failure streaks that began before it, so an
    // owner who reset a forgotten PIN/pattern can log in without waiting out a
    // lockout charged against the old secret. See `isFailStreakVoid`.
    secretUpdatedAt: Date.now(),
  };

  await c.env.KV.put(kvKeys.verify(userId), JSON.stringify(record));

  return c.json({ data: { method: record.method, prompted: record.prompted } });
});

// POST /:id/verify/otp — generate OTP (protected, Extension pushes OTP for display)
const postVerifyOtpRoute = createRoute({
  method: "post",
  path: "/{id}/verify/otp",
  tags: ["Verify"],
  summary: "Generate OTP code",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Generated OTP code"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
  },
});

verifyRoutes.openapi(postVerifyOtpRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Verify user has 'code' method set
  const verifyRecord = await c.env.KV.get<VerifyRecord>(
    kvKeys.verify(userId),
    "json",
  );
  if (!verifyRecord || verifyRecord.method !== "code") {
    return jsonError(
      c,
      400,
      "INVALID_METHOD",
      "Verification method must be 'code' to generate OTP",
    );
  }

  const code = generateOtpCode();
  const otpRecord: OtpRecord = {
    code,
    createdAt: new Date().toISOString(),
  };

  await c.env.KV.put(kvKeys.otp(userId), JSON.stringify(otpRecord), {
    expirationTtl: OTP_TTL_SECONDS,
  });

  const expiresAt = Date.now() + OTP_TTL_SECONDS * 1000;

  return c.json({ data: { code, expiresAt } });
});

// POST /:id/verify/prompted — mark user as prompted (protected, prevents abuse)
const postVerifyPromptedRoute = createRoute({
  method: "post",
  path: "/{id}/verify/prompted",
  tags: ["Verify"],
  summary: "Mark user as prompted for verification",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Prompted status updated"),
    400: jsonRes("Invalid user ID"),
    401: jsonRes("Unauthorized"),
  },
});

verifyRoutes.openapi(postVerifyPromptedRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  const existing = await c.env.KV.get<VerifyRecord>(
    kvKeys.verify(userId),
    "json",
  );
  const record: VerifyRecord = existing ?? defaultVerifyRecord();
  record.prompted = 1;

  await c.env.KV.put(kvKeys.verify(userId), JSON.stringify(record));

  return c.json({ data: { method: record.method, prompted: record.prompted } });
});

/** Generate a 32-byte random hex token (64 hex chars). */
function generateQrToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// POST /:id/qr-token — generate a one-time QR token for verification bypass (protected)
const postQrTokenRoute = createRoute({
  method: "post",
  path: "/{id}/qr-token",
  tags: ["Verify"],
  summary: "Generate QR token for verification bypass",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Generated QR token"),
    400: jsonRes("Invalid user ID"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
  },
});

verifyRoutes.openapi(postQrTokenRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return jsonError(c, 400, "INVALID_USER_ID", "userId format is invalid");
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  if (callerId !== userId) {
    return jsonError(c, 403, "FORBIDDEN", "只能為自己產生 QR Token");
  }

  const token = generateQrToken();
  const record: QrTokenRecord = { userId };

  await c.env.KV.put(kvKeys.qrToken(token), JSON.stringify(record), {
    expirationTtl: QR_TOKEN_TTL_SECONDS,
  });

  return c.json({ data: { token, expiresIn: QR_TOKEN_TTL_SECONDS } });
});

/** Error descriptor returned by {@link validateVerification} on failure. */
export type VerificationError =
  | {
      /**
       * `VERIFICATION_LOCKED` — this caller burned its failure budget.
       * `RATE_LIMITED` — a WRONG guess arrived while the target account's global
       * attempt ceiling was already spent (same code/shape as the rate-limit
       * middleware, so clients that already handle 429 RATE_LIMITED need no
       * change). A correct secret is never answered this way.
       */
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

/**
 * Compare a submitted secret against the stored verify record.
 *
 * Returns null when a pin/pattern record is corrupted (missing hash/salt);
 * callers treat that as "no verification configured".
 *
 * `consumeOtp` decides whether a successful `code` match deletes the OTP
 * (one-time use). Read-only checks pass `false` — see {@link validateVerification}.
 */
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

/**
 * Charge one failed attempt against the caller-scoped record, locking that
 * caller out once VERIFY_MAX_FAILURES is reached. Side effect: writes
 * `verifyfail:{userId}:{callerKey}` with a TTL; never touches `verify:{userId}`.
 */
async function chargeFailure(
  kv: KVNamespace,
  failKey: string,
  existing: VerifyFailRecord | null,
): Promise<void> {
  const next: VerifyFailRecord = {
    failCount: (existing?.failCount ?? 0) + 1,
    lockedUntil: null,
    // Continuing an existing streak keeps its original start; a fresh streak
    // starts now. Kept as-is through the lockout reset below — the entry remains
    // the same streak until its TTL expires or it is cleared/voided.
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

/**
 * Whether a caller's failure streak is void because the account owner changed
 * the verification secret/method after the streak began. A void streak must not
 * lock anyone out and must not carry its `failCount` forward: it accumulated
 * against a secret that no longer exists, so holding it would only punish the
 * owner who just reset a forgotten PIN/pattern.
 *
 * Missing-field default is the SAFE side: legacy records written before either
 * timestamp existed lack one or both values, and those keep the lockout in
 * force (current behaviour). Absence never unlocks.
 *
 * Threat model — this is not a DoS lever. `secretUpdatedAt` can only be advanced
 * through `PUT /:id/verify`, which requires a valid auth token AND
 * `callerId === userId`. So only the account owner can void failure records, and
 * only on their own account.
 *
 * Pure predicate: re-derived on every read, so a void record that has not been
 * deleted yet is still inert. Deletion is cleanup, never correctness.
 */
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

/**
 * Read the target account's global attempt ceiling WITHOUT charging it.
 * Returns `null` under DEV_MODE, where the ceiling does not apply and nothing
 * was read — matching every other limiter.
 *
 * Called only from {@link chargeWrongGuess}, i.e. AFTER the secret has been
 * compared and found wrong. A correct secret is neither refused by the ceiling
 * nor charged to it, so the legitimate path never touches this counter at all —
 * one KV read fewer on the hot path, and, crucially, no way for a spent window
 * to keep the account owner out.
 *
 * The counter derivation is delegated to `peekPerUserRateLimit`, the same
 * implementation the rate-limit middleware uses, so the two cannot drift.
 */
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

/**
 * Charge one WRONG guess against the ceiling read by {@link peekAttemptCeiling}.
 *
 * Side effect: writes `ratelimit:user:verify:{userId}:{bucket}`. No-op under
 * DEV_MODE (no reading was taken) and when the window is already spent — a
 * refused attempt must not extend it. Touches only the counter key — this
 * caller's failure streak is a different key, charged by {@link chargeFailure}.
 */
async function chargeFailedAttempt(
  kv: KVNamespace,
  reading: PerUserRateLimitReading | null,
): Promise<void> {
  if (!reading || reading.verdict.limited) return;
  await chargePerUserRateLimit(kv, reading);
}

/**
 * Charge one wrong guess against both brakes, and report the ceiling state that
 * decides which refusal it earns (`limited` ⇒ 429 `RATE_LIMITED`, otherwise 403
 * `VERIFICATION_FAILED`).
 *
 * The ceiling is read here — after the comparison — so that only a wrong guess
 * is ever measured against it. Two writes happen, but to two DIFFERENT keys (the
 * account-wide attempt counter and this caller's failure streak), so the "at
 * most one write per KV key per request" rule still holds.
 */
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
 * against attackers, not against the account it protects. Same shape as the
 * join endpoint's `"join"` counter, and it does not contradict the caller-scoped
 * lockout rule: that rule governs who gets *locked*, not whether a global
 * attempt ceiling may exist.
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

  // Streak predating the current secret — treat this request as a clean slate.
  // Decided in memory only; whether the stale entry is deleted depends on which
  // path we exit through (a path that writes the same key must not delete first).
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

  // Secret required but not provided — no attempt was made, so nothing to
  // charge. This path performs no KV write at all: a void leftover is inert and
  // simply waits for its TTL or for the next request to overwrite/clear it.
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

  // Compare FIRST. The account-wide attempt ceiling is deliberately not
  // consulted before this point: it is keyed on the target userId, so refusing a
  // correct secret because the window is spent would let any third party lock
  // the owner out of their own onboarding. Correctness of the secret is decided
  // before the ceiling has any say.
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
    // The only path that touches the target account's attempt ceiling. Reading
    // it here (rather than up front) is what keeps a spent window from ever
    // refusing the owner. `chargeFailure` overwrites the whole entry, so a void
    // leftover is replaced here rather than deleted first.
    const ceiling = await chargeWrongGuess(env, userId, failKey, failRecord);
    if (ceiling.limited) {
      // Wrong guess AND the account's hourly guessing budget is already spent:
      // report the ceiling rather than a plain verification failure, so the
      // caller learns that waiting — not another guess — is the way forward.
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
