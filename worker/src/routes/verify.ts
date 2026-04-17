import { Hono } from "hono";
import type { Env } from "../utils/env";
import {
  kvKeys,
  OTP_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  VERIFY_MAX_FAILURES,
  VERIFY_LOCKOUT_MS,
  type VerifyRecord,
  type OtpRecord,
  type QrTokenRecord,
} from "../kv/schema";
import { isValidUserId, isValidVerifyMethod, isValidPin, isValidPattern } from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";

export const verifyRoutes = new Hono<{ Bindings: Env }>();

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
  const num = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 1000000).padStart(6, "0");
}

/** Build default verify record. */
function defaultVerifyRecord(): VerifyRecord {
  return {
    method: "none",
    hash: null,
    salt: null,
    prompted: 0,
    failCount: 0,
    lockedUntil: null,
  };
}

/** Check if user is currently locked out. Returns true if locked. */
function isLockedOut(record: VerifyRecord): boolean {
  if (!record.lockedUntil) return false;
  return Date.now() < record.lockedUntil;
}

// GET /:id/verify — get verification method (public, needed before login)
verifyRoutes.get("/:id/verify", async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const record = await c.env.KV.get<VerifyRecord>(kvKeys.verify(userId), "json");
  const method = record?.method ?? "none";
  const prompted = record?.prompted ?? 0;

  return c.json({ data: { method, prompted } });
});

// PUT /:id/verify — set or change verification method (protected)
verifyRoutes.put("/:id/verify", async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  let body: { method: string; secret?: string; prompted?: number } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body || !isValidVerifyMethod(body.method)) {
    return c.json(
      { error: { code: "INVALID_METHOD", message: "method must be one of: pin, pattern, code, none" } },
      400,
    );
  }

  const method = body.method;

  // Validate secret for pin/pattern
  if (method === "pin") {
    if (!body.secret || typeof body.secret !== "string" || !isValidPin(body.secret)) {
      return c.json(
        { error: { code: "INVALID_SECRET", message: "PIN must be 6-12 digits" } },
        400,
      );
    }
  } else if (method === "pattern") {
    if (!body.secret || typeof body.secret !== "string" || !isValidPattern(body.secret)) {
      return c.json(
        { error: { code: "INVALID_SECRET", message: "Pattern must have 4-9 unique nodes (0-8), comma-separated" } },
        400,
      );
    }
  }

  let hash: string | null = null;
  let salt: string | null = null;

  if ((method === "pin" || method === "pattern") && body.secret) {
    salt = generateSalt();
    hash = await hashSecret(salt, body.secret);
  }

  const existing = await c.env.KV.get<VerifyRecord>(kvKeys.verify(userId), "json");

  const record: VerifyRecord = {
    method,
    hash,
    salt,
    prompted: body.prompted === 1 ? 1 : (existing?.prompted ?? 0),
    failCount: 0,
    lockedUntil: null,
  };

  await c.env.KV.put(kvKeys.verify(userId), JSON.stringify(record));

  return c.json({ data: { method: record.method, prompted: record.prompted } });
});

// POST /:id/verify/otp — generate OTP (protected, Extension pushes OTP for display)
verifyRoutes.post("/:id/verify/otp", async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  // Verify user has 'code' method set
  const verifyRecord = await c.env.KV.get<VerifyRecord>(kvKeys.verify(userId), "json");
  if (!verifyRecord || verifyRecord.method !== "code") {
    return c.json(
      { error: { code: "INVALID_METHOD", message: "Verification method must be 'code' to generate OTP" } },
      400,
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
verifyRoutes.post("/:id/verify/prompted", async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  const existing = await c.env.KV.get<VerifyRecord>(kvKeys.verify(userId), "json");
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
verifyRoutes.post("/:id/qr-token", async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  if (callerId !== userId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "只能為自己產生 QR Token" } },
      403,
    );
  }

  const token = generateQrToken();
  const record: QrTokenRecord = { userId };

  await c.env.KV.put(kvKeys.qrToken(token), JSON.stringify(record), {
    expirationTtl: QR_TOKEN_TTL_SECONDS,
  });

  return c.json({ data: { token, expiresIn: QR_TOKEN_TTL_SECONDS } });
});

/**
 * Validate a verification secret against stored record.
 * Used by join flow.
 * Returns: { valid: true } or error response.
 */
export async function validateVerification(
  kv: KVNamespace,
  userId: string,
  secret: string | undefined,
): Promise<{ valid: boolean; error?: { code: string; message: string; status: number } }> {
  const record = await kv.get<VerifyRecord>(kvKeys.verify(userId), "json");

  // No verification set or method is 'none' — allow through
  if (!record || record.method === "none") {
    return { valid: true };
  }

  // Check lockout
  if (isLockedOut(record)) {
    return {
      valid: false,
      error: { code: "VERIFICATION_LOCKED", message: "驗證已鎖定，請稍後再試", status: 429 },
    };
  }

  // Secret required but not provided
  if (!secret || typeof secret !== "string") {
    return {
      valid: false,
      error: { code: "VERIFICATION_REQUIRED", message: "此帳號需要驗證才能登入", status: 403 },
    };
  }

  let valid = false;

  if (record.method === "pin" || record.method === "pattern") {
    if (!record.hash || !record.salt) {
      // Corrupted record — treat as no verification
      return { valid: true };
    }
    const inputHash = await hashSecret(record.salt, secret);
    valid = timingSafeEqual(inputHash, record.hash);
  } else if (record.method === "code") {
    // Validate OTP — pad both to same length for constant-time comparison
    const otpRecord = await kv.get<OtpRecord>(kvKeys.otp(userId), "json");
    if (otpRecord && secret.length === otpRecord.code.length && timingSafeEqual(otpRecord.code, secret)) {
      valid = true;
      // Delete OTP after successful use (one-time)
      await kv.delete(kvKeys.otp(userId));
    }
  }

  if (!valid) {
    // Increment fail count
    record.failCount = (record.failCount || 0) + 1;
    if (record.failCount >= VERIFY_MAX_FAILURES) {
      record.lockedUntil = Date.now() + VERIFY_LOCKOUT_MS;
      record.failCount = 0; // Reset count after lockout
    }
    await kv.put(kvKeys.verify(userId), JSON.stringify(record));

    return {
      valid: false,
      error: { code: "VERIFICATION_FAILED", message: "驗證失敗", status: 403 },
    };
  }

  // Reset fail count on success
  if (record.failCount > 0) {
    record.failCount = 0;
    record.lockedUntil = null;
    await kv.put(kvKeys.verify(userId), JSON.stringify(record));
  }

  return { valid: true };
}
