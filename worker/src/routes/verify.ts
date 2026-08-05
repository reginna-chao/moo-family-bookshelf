import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
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
} from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
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

/** Check if the caller is currently locked out. Returns true if locked. */
function isLockedOut(record: VerifyFailRecord | null): boolean {
  if (!record?.lockedUntil) return false;
  return Date.now() < record.lockedUntil;
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

/**
 * Compare a submitted secret against the stored verify record.
 *
 * Returns null when a pin/pattern record is corrupted (missing hash/salt);
 * callers treat that as "no verification configured". Consumes the OTP on a
 * successful `code` match (one-time use).
 */
async function matchesSecret(
  kv: KVNamespace,
  userId: string,
  record: VerifyRecord,
  secret: string,
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
      // Delete OTP after successful use (one-time)
      await kv.delete(kvKeys.otp(userId));
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
 * Validate a verification secret against the stored `verify:{userId}` record.
 * Used by the join flow.
 *
 * Failure accounting and lockout are keyed on the CALLER (`opts.callerKey`,
 * normally the Cloudflare-supplied client IP, IPv6 bucketed per /64), never on
 * the target user, and live in a TTL-backed `verifyfail:{userId}:{callerKey}`
 * entry. Reason: join is a public endpoint, the submitted userId is derived
 * from the user's email with a fixed salt, and the victim's own familyId is
 * retrievable from the public `POST /api/auth/lookup` — so ANY counter keyed on
 * the victim's identity is a denial-of-service lever, letting a stranger lock
 * the victim out of PWA login on demand. Brute force from a SINGLE source stays
 * bounded by the per-IP sensitive-route limit (3/min); an attacker who rotates
 * source prefixes is bounded only by the per-userId join rate limit (10/hour).
 * Neither bound holds under `DEV_MODE=1`, which short-circuits both limits and
 * leaves lockout as the only brake.
 *
 * This function never writes `verify:{userId}`.
 *
 * Returns: { valid: true } or error response.
 */
export async function validateVerification(
  kv: KVNamespace,
  userId: string,
  secret: string | undefined,
  opts: { callerKey: string },
): Promise<{
  valid: boolean;
  error?: { code: string; message: string; status: number };
}> {
  const record = await kv.get<VerifyRecord>(kvKeys.verify(userId), "json");

  // No verification set or method is 'none' — allow through
  if (!record || record.method === "none") {
    return { valid: true };
  }

  const failKey = kvKeys.verifyFail(userId, opts.callerKey);
  const failRecord = await kv.get<VerifyFailRecord>(failKey, "json");

  // Check lockout for this caller
  if (isLockedOut(failRecord)) {
    return {
      valid: false,
      error: {
        code: "VERIFICATION_LOCKED",
        message: "驗證已鎖定，請稍後再試",
        status: 429,
      },
    };
  }

  // Secret required but not provided — no attempt was made, so nothing to charge
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

  const matched = await matchesSecret(kv, userId, record, secret);

  // Corrupted record — treat as no verification
  if (matched === null) {
    return { valid: true };
  }

  if (!matched) {
    await chargeFailure(kv, failKey, failRecord);
    return {
      valid: false,
      error: { code: "VERIFICATION_FAILED", message: "驗證失敗", status: 403 },
    };
  }

  // Success — clear this caller's failure history
  if (failRecord) {
    await kv.delete(failKey);
  }

  return { valid: true };
}
