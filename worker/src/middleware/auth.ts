import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import { kvKeys, type AuthRecord, TOKEN_TTL_SECONDS } from "../kv/schema";
import { isPublicRoute } from "../utils/routes";
import { jsonError } from "../utils/errors";
import { hashSecret, timingSafeEqual } from "../utils/crypto";

// Extend Hono Variables to carry authenticated userId
declare module "hono" {
  interface ContextVariableMap {
    authUserId: string | null; // null = no auth header (fallback mode)
  }
}

/** The 64-char hex token of a `Bearer <token>` header, or `null` when the header is absent or malformed. */
function parseBearerToken(authHeader: string | undefined): string | null {
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  if (!match || !/^[a-f0-9]{64}$/.test(match[1])) return null;
  return match[1];
}

/**
 * Auth middleware: checks Authorization header.
 * Requires valid Bearer token for all protected routes.
 * Public routes (create/join family) are skipped.
 */
export const authMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    if (isPublicRoute(c.req.method, c.req.path)) {
      c.set("authUserId", null);
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return jsonError(c, 401, "UNAUTHORIZED", "Authorization header required");
    }

    const token = parseBearerToken(authHeader);
    if (!token) {
      return jsonError(c, 401, "UNAUTHORIZED", "Invalid or expired token");
    }

    const userId = await c.env.KV.get(kvKeys.authToken(token));

    if (!userId) {
      return jsonError(c, 401, "UNAUTHORIZED", "Invalid or expired token");
    }

    c.set("authUserId", userId);
    await next();
  },
);

/**
 * Returns the authenticated userId from context.
 * Returns null if not authenticated (should not happen on protected routes).
 */
export function getAuthenticatedUserId(c: Context): string | null {
  return c.get("authUserId") as string | null;
}

/** The bearer token the request presented (already validated by `authMiddleware` on protected routes). */
export function getPresentedAuthToken(c: Context): string | null {
  return parseBearerToken(c.req.header("Authorization"));
}

/**
 * Generate a new auth token for a user and store both directions in KV.
 * Serialized: delete old token first, then write new one to avoid
 * orphaned token entries from concurrent requests.
 *
 * `knownAuth` lets a caller that has already read `auth:{userId}` avoid a
 * redundant KV read: pass the record (or `null` if the caller looked and
 * found nothing) to skip the read. Leave it `undefined` (the default) to
 * have this function read the record itself. The null-vs-undefined
 * distinction matters — `null` means "already looked, nothing there".
 *
 * `secretAt` is written as the new record's `AuthRecord.secretAt` (PIN/pattern
 * rotation only); when omitted, the replaced record's value is carried forward.
 *
 * Returns the token string.
 */
export async function generateAuthToken(
  kv: KVNamespace,
  userId: string,
  knownAuth?: AuthRecord | null,
  secretAt?: number,
): Promise<string> {
  // 1. Delete any existing token first (serialized to avoid orphans).
  //    Reuse the caller's already-read record when provided.
  const existingAuth =
    knownAuth === undefined
      ? await kv.get<AuthRecord>(kvKeys.auth(userId), "json")
      : knownAuth;
  if (existingAuth?.token) {
    await kv.delete(kvKeys.authToken(existingAuth.token));
  }

  // 2. Generate new token
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const carriedSecretAt = secretAt ?? existingAuth?.secretAt;
  const authRecord: AuthRecord = {
    token,
    createdAt: new Date().toISOString(),
    ...(typeof carriedSecretAt === "number" && { secretAt: carriedSecretAt }),
  };

  // 3. Write both directions with TTL
  await Promise.all([
    kv.put(kvKeys.auth(userId), JSON.stringify(authRecord), {
      expirationTtl: TOKEN_TTL_SECONDS,
    }),
    kv.put(kvKeys.authToken(token), userId, {
      expirationTtl: TOKEN_TTL_SECONDS,
    }),
  ]);

  return token;
}

/**
 * Renew-only (#378): when `auth`'s token still has its reverse `token:{token}`
 * entry mapping to `userId`, slide both entries' TTL (token, createdAt and
 * secretAt kept) and return it; otherwise write nothing and return `null`.
 * One KV read. Never mints — the QR-bypass join relies on that.
 */
export async function renewAuthToken(
  kv: KVNamespace,
  userId: string,
  auth: AuthRecord | null,
): Promise<string | null> {
  if (!auth?.token) return null;
  if ((await kv.get(kvKeys.authToken(auth.token))) !== userId) return null;
  await Promise.all([
    kv.put(kvKeys.auth(userId), JSON.stringify(auth), {
      expirationTtl: TOKEN_TTL_SECONDS,
    }),
    kv.put(kvKeys.authToken(auth.token), userId, {
      expirationTtl: TOKEN_TTL_SECONDS,
    }),
  ]);
  return auth.token;
}

/**
 * Return the existing valid auth token for a user (renewed via
 * `renewAuthToken`), or generate a new one. Prevents token churn when the same
 * user re-joins from multiple devices. `knownAuth` skips the `auth:{userId}`
 * read, with the same null-vs-undefined meaning as in `generateAuthToken`.
 */
export async function getOrGenerateAuthToken(
  kv: KVNamespace,
  userId: string,
  knownAuth?: AuthRecord | null,
): Promise<string> {
  const existingAuth =
    knownAuth === undefined ? await readAuthRecord(kv, userId) : knownAuth;
  const renewed = await renewAuthToken(kv, userId, existingAuth);
  if (renewed !== null) return renewed;
  // No valid token: mint one, passing the record already read (AuthRecord | null, never
  // undefined) so generateAuthToken does not re-read auth:{userId}.
  return generateAuthToken(kv, userId, existingAuth);
}

/** Read `auth:{userId}` — the account's one current token record; `null` when there is none. */
export async function readAuthRecord(
  kv: KVNamespace,
  userId: string,
): Promise<AuthRecord | null> {
  return kv.get<AuthRecord>(kvKeys.auth(userId), "json");
}

/** `auth:{userId}` as read, and whether the presented bearer is still the account's current token. */
export interface PresentedAuth {
  auth: AuthRecord | null;
  current: boolean;
}

/**
 * Bearer currency (#378), the one rule shared by refresh (`renewPresentedAuthToken`),
 * `PUT /api/user/:id/verify` and `POST /api/user/:id/verify/prompted`: the presented token is current when
 * `auth:{userId}` names it, or when there is no record at all (TTL gap). A revoked
 * bearer still accepted by a colo that has not seen the delete is NOT current.
 * A missing bearer is never current. One KV read; the record is returned for reuse.
 */
export async function readPresentedAuth(
  kv: KVNamespace,
  userId: string,
  presentedToken: string | null,
): Promise<PresentedAuth> {
  const auth = await readAuthRecord(kv, userId);
  const current =
    presentedToken !== null &&
    (!auth?.token || timingSafeEqual(auth.token, presentedToken));
  return { auth, current };
}

/**
 * Refresh's renewal (#378): `null` when the presented bearer is not current
 * (`readPresentedAuth`) — it must never be handed the account's NEW token. A
 * current one goes through `getOrGenerateAuthToken`, reusing that one read.
 */
export async function renewPresentedAuthToken(
  kv: KVNamespace,
  userId: string,
  presentedToken: string,
): Promise<string | null> {
  const { auth, current } = await readPresentedAuth(kv, userId, presentedToken);
  if (!current) return null;
  return getOrGenerateAuthToken(kv, userId, auth);
}

/** Fixed salt of the QR binding hash below; a hash of the raw token, never the token itself, sits in `qr:{token}`. */
const QR_BINDING_SALT = "qr:";

/** Hex SHA-256 of the auth token that mints a QR token, stored as `QrTokenRecord.tokenHash` (#378). */
export function hashTokenForQrBinding(authToken: string): Promise<string> {
  return hashSecret(QR_BINDING_SALT, authToken);
}

/**
 * QR redeem rule (#378): a QR token may skip verification only while `auth` — the
 * just-read `auth:{userId}` — still names the token that minted it. No KV op: the
 * join then only RENEWS that token (`renewAuthToken`), whose reverse-entry read
 * refuses a token the rotation already deleted. A record without `tokenHash`
 * (older shape) never bypasses.
 */
export async function isQrBoundToCurrentToken(
  tokenHash: string | undefined,
  auth: AuthRecord | null,
): Promise<boolean> {
  if (typeof tokenHash !== "string" || !auth?.token) return false;
  const expected = await hashTokenForQrBinding(auth.token);
  return timingSafeEqual(expected, tokenHash);
}

/**
 * Delete the auth token for a user (both directions).
 */
export async function deleteAuthToken(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  const authRecord = await kv.get<AuthRecord>(kvKeys.auth(userId), "json");

  const ops: Promise<void>[] = [kv.delete(kvKeys.auth(userId))];
  if (authRecord?.token) {
    ops.push(kv.delete(kvKeys.authToken(authRecord.token)));
  }

  await Promise.all(ops);
}
