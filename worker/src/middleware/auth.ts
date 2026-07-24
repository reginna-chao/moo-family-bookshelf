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
 *
 * `knownAuth` lets a caller that has already read `auth:{userId}` avoid a
 * redundant KV read: pass the record (or `null` if the caller looked and
 * found nothing) to skip the read. Leave it `undefined` (the default) to
 * have this function read the record itself. The null-vs-undefined
 * distinction matters — `null` means "already looked, nothing there".
 *
 * Returns the token string.
 */
export async function generateAuthToken(
  kv: KVNamespace,
  userId: string,
  knownAuth?: AuthRecord | null,
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
      // Sliding TTL: refresh both KV entries so their expiry matches the
      // expiresAt the routes report to the client. Keep the original token
      // and createdAt — only the TTL is renewed.
      await Promise.all([
        kv.put(kvKeys.auth(userId), JSON.stringify(existingAuth), {
          expirationTtl: TOKEN_TTL_SECONDS,
        }),
        kv.put(kvKeys.authToken(existingAuth.token), userId, {
          expirationTtl: TOKEN_TTL_SECONDS,
        }),
      ]);
      return existingAuth.token;
    }
  }
  // No valid token found — generate a fresh one, reusing the record we
  // already read (existingAuth is AuthRecord | null, never undefined) so
  // generateAuthToken does not re-read auth:{userId}.
  return generateAuthToken(kv, userId, existingAuth);
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
