import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import { kvKeys, type AuthRecord, TOKEN_TTL_SECONDS } from "../kv/schema";
import { isPublicRoute } from "../utils/routes";
import { jsonError } from "../utils/errors";

// Extend Hono Variables to carry authenticated userId
declare module "hono" {
  interface ContextVariableMap {
    authUserId: string | null; // null = no auth header (fallback mode)
  }
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

    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (!match) {
      return jsonError(c, 401, "UNAUTHORIZED", "Invalid or expired token");
    }

    const token = match[1];

    // Validate token format (64-char hex)
    if (!/^[a-f0-9]{64}$/.test(token)) {
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

/**
 * Generate a new auth token for a user and store both directions in KV.
 * Serialized: delete old token first, then write new one to avoid
 * orphaned token entries from concurrent requests.
 * Returns the token string.
 */
export async function generateAuthToken(
  kv: KVNamespace,
  userId: string,
): Promise<string> {
  // 1. Delete any existing token first (serialized to avoid orphans)
  const existingAuth = await kv.get<AuthRecord>(kvKeys.auth(userId), "json");
  if (existingAuth?.token) {
    await kv.delete(kvKeys.authToken(existingAuth.token));
  }

  // 2. Generate new token
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authRecord: AuthRecord = {
    token,
    createdAt: new Date().toISOString(),
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
 * Return the existing valid auth token for a user, or generate a new one.
 * Prevents token churn when the same user re-joins from multiple devices.
 */
export async function getOrGenerateAuthToken(
  kv: KVNamespace,
  userId: string,
): Promise<string> {
  const existingAuth = await kv.get<AuthRecord>(kvKeys.auth(userId), "json");
  if (existingAuth?.token) {
    // Verify the reverse lookup still exists (KV TTL may have expired it)
    const reverseUserId = await kv.get(kvKeys.authToken(existingAuth.token));
    if (reverseUserId === userId) {
      return existingAuth.token;
    }
  }
  // No valid token found — generate a fresh one
  return generateAuthToken(kv, userId);
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
