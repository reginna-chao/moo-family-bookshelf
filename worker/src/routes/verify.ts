import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import {
  OTP_TTL_SECONDS,
  QR_TOKEN_TTL_SECONDS,
  TOKEN_TTL_SECONDS,
  type VerifyRecord,
  type OtpRecord,
  type QrTokenRecord,
} from "../kv/schema";
import {
  getVerifyRecord,
  putVerifyRecord,
  putOtpRecord,
  putQrTokenRecord,
  deleteOtpRecord,
} from "../kv/verify";
import {
  isValidVerifyMethod,
  isValidPin,
  isValidPattern,
} from "../utils/validation";
import {
  generateAuthToken,
  getAuthenticatedUserId,
  getPresentedAuthToken,
  hashTokenForQrBinding,
  readPresentedAuth,
} from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { passedAgainstStaleVerifyRecord } from "../services/verification";
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
    200: jsonRes("Verification method only (no hash, no prompted status)"),
    400: jsonRes("Invalid user ID"),
  },
});

verifyRoutes.openapi(getVerifyRoute, async (c) => {
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const record = await getVerifyRecord(c.env.KV, userId);
  const method = record?.method ?? "none";

  // `prompted` is owner-only (#343): it would reveal who has used the PWA.
  return c.json({ data: { method } });
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
    200: jsonRes(
      "Updated verification settings; for pin/pattern also the rotated authToken + expiresAt (the old token is revoked). code/none keep the token",
    ),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    429: jsonRes("Rate limited"),
  },
});

verifyRoutes.openapi(putVerifyRoute, async (c) => {
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Shared "verify-write" ceiling (30/hr, the four verify-domain writes), kept apart from the gate's
  // "verify" counter. See docs/architecture.md → 每帳號寫入上限能擋住什麼.
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

  // Only the token `auth:{userId}` names may change the secret (#378): a revoked bearer that a stale colo
  // still accepts gets this handler's generic 401. See docs/architecture.md → PWA 登入驗證機制.
  const presentedToken = getPresentedAuthToken(c);
  const [presented, existing] = await Promise.all([
    readPresentedAuth(c.env.KV, userId, presentedToken),
    getVerifyRecord(c.env.KV, userId),
  ]);
  if (!presented.current || presentedToken === null) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  let hash: string | null = null;
  let salt: string | null = null;

  if ((method === "pin" || method === "pattern") && body.secret) {
    salt = generateSalt();
    hash = await hashSecret(salt, body.secret);
  }

  const record: VerifyRecord = {
    method,
    hash,
    salt,
    prompted: body.prompted === 1 ? 1 : (existing?.prompted ?? 0),
    // Voids failure streaks begun before this change (`isFailStreakVoid`), so a reset PIN/pattern
    // is not locked out by the old secret's lockout.
    secretUpdatedAt: Date.now(),
  };

  await putVerifyRecord(c.env.KV, userId, record);

  if (method !== "pin" && method !== "pattern") {
    return c.json({
      data: { method: record.method, prompted: record.prompted },
    });
  }

  // A new PIN/pattern revokes the shared token (#378) AFTER the record write and drops a pending one-time
  // code; `code` keeps the token (the Extension cannot enter an OTP). See docs/architecture.md → PWA 登入驗證機制.
  // No `auth:` record (TTL gap): the presented bearer is still the one to revoke; only `.token` is read.
  // `secretAt` lets a stale-node join be refused (`passedAgainstStaleVerifyRecord`).
  const replaced = presented.auth ?? { token: presentedToken, createdAt: "" };
  const [authToken] = await Promise.all([
    generateAuthToken(c.env.KV, userId, replaced, record.secretUpdatedAt),
    deleteOtpRecord(c.env.KV, userId),
  ]);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({
    data: {
      method: record.method,
      prompted: record.prompted,
      authToken,
      expiresAt,
    },
  });
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
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

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
  const verifyRecord = await getVerifyRecord(c.env.KV, userId);
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

  await putOtpRecord(c.env.KV, userId, otpRecord);

  const expiresAt = Date.now() + OTP_TTL_SECONDS * 1000;

  return c.json({ data: { code, expiresAt } });
});

// GET /:id/verify/prompted — read prompted status (protected, owner only; #343)
const getVerifyPromptedRoute = createRoute({
  method: "get",
  path: "/{id}/verify/prompted",
  tags: ["Verify"],
  summary: "Get whether the user was prompted to set up verification",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Prompted status"),
    400: jsonRes("Invalid user ID"),
    401: jsonRes("Unauthorized"),
  },
});

verifyRoutes.openapi(getVerifyPromptedRoute, async (c) => {
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);
  if (!callerId || callerId !== userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // A read: no VERIFY_WRITE_LIMIT; the per-IP authenticated tier still applies.
  const record = await getVerifyRecord(c.env.KV, userId);

  return c.json({ data: { prompted: record?.prompted ?? 0 } });
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
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

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

  const [existing, presented] = await Promise.all([
    getVerifyRecord(c.env.KV, userId),
    readPresentedAuth(c.env.KV, userId, getPresentedAuthToken(c)),
  ]);
  if (!presented.current) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Never write back a record older than the last PIN/pattern rotation (#378), nor rewrite one already
  // prompted. See docs/architecture.md → PWA 登入驗證機制.
  if (
    existing?.prompted === 1 ||
    passedAgainstStaleVerifyRecord(presented.auth, existing)
  ) {
    return c.json({
      data: { method: existing?.method ?? "none", prompted: 1 },
    });
  }

  const record: VerifyRecord = existing ?? defaultVerifyRecord();
  record.prompted = 1;

  await putVerifyRecord(c.env.KV, userId, record);

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
  // Format already enforced by UserIdParam (400 INVALID_USER_ID).
  const { id: userId } = c.req.valid("param");

  const callerId = getAuthenticatedUserId(c);
  const presentedToken = getPresentedAuthToken(c);
  if (!callerId || !presentedToken) {
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
  // Bound to the minting token (#378): redeemable only while `auth:{userId}` still names it.
  const tokenHash = await hashTokenForQrBinding(presentedToken);
  const record: QrTokenRecord = { userId, tokenHash };

  await putQrTokenRecord(c.env.KV, token, record);

  return c.json({ data: { token, expiresIn: QR_TOKEN_TTL_SECONDS } });
});
