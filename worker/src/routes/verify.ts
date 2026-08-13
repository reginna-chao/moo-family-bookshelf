import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import {
  kvKeys,
  OTP_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  type VerifyRecord,
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
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { hashSecret } from "../utils/crypto";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { UserIdParam } from "../schemas/common";

export const verifyRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

/** Shared per-userId write ceiling for the four verify-domain write handlers. */
export const VERIFY_WRITE_LIMIT = {
  scope: "verify-write",
  max: 30,
  windowSec: 3600,
} as const;

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
    429: jsonRes("Rate limited"),
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

  // Per-userId write ceiling: 30 verify-domain writes per userId per hour, shared
  // by PUT verify / OTP / prompted / qr-token under one "verify-write" scope.
  // Layered on top of the per-IP limit. Honest scope: this BOUNDS THE BURN RATE
  // of a single AUTHENTICATED account's KV writes (~60 writes/hr = 30 handler
  // writes + 30 counter writes; ~90/hr once the per-IP counter is counted too),
  // it does NOT make the daily 1000-write free tier safe by itself — 30/hr
  // sustained is still ~1,440 KV writes/day from one account, and the per-IP
  // middleware's own counter write lands BEFORE auth, so spam that ignores 429s
  // still burns writes outside this ceiling's reach. Since userId is not a
  // credential, a self-minted account could otherwise drain the daily quota in
  // minutes; this turns that into hours and forces an attacker to onboard a new
  // account per 30 writes. A hard global bound needs the edge (Cloudflare WAF
  // rate limiting, see docs/architecture.md and worker/DEPLOY.md).
  //
  // The scope is deliberately DISTINCT from the verification gate's "verify"
  // wrong-guess attempt ceiling (`VERIFY_ATTEMPT_SCOPE`, 10/hr, in
  // `services/verification.ts`): sharing one counter would let an attacker's
  // wrong guesses crowd out the owner's own settings operations, and vice versa.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...VERIFY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

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
    429: jsonRes("Rate limited"),
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

  // Shared "verify-write" per-userId write ceiling (30/hr across the four verify
  // write handlers) — see the PUT /{id}/verify handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...VERIFY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

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
    429: jsonRes("Rate limited"),
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

  // Shared "verify-write" per-userId write ceiling (30/hr across the four verify
  // write handlers) — see the PUT /{id}/verify handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...VERIFY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

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
    429: jsonRes("Rate limited"),
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

  // Shared "verify-write" per-userId write ceiling (30/hr across the four verify
  // write handlers) — see the PUT /{id}/verify handler for rationale.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    ...VERIFY_WRITE_LIMIT,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const token = generateQrToken();
  const record: QrTokenRecord = { userId };

  await c.env.KV.put(kvKeys.qrToken(token), JSON.stringify(record), {
    expirationTtl: QR_TOKEN_TTL_SECONDS,
  });

  return c.json({ data: { token, expiresIn: QR_TOKEN_TTL_SECONDS } });
});
