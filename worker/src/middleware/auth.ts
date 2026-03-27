import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../index";
import { kvKeys, type AuthRecord } from "../kv/schema";
import { isPublicRoute } from "../utils/routes";

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
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authorization header required" } },
        401,
      );
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (!match) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } },
        401,
      );
    }

    const token = match[1];

    // Validate token format (64-char hex)
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } },
        401,
      );
    }

    const userId = await c.env.KV.get(kvKeys.authToken(token));

    if (!userId) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } },
        401,
      );
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

/** Token TTL: 90 days in seconds */
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

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
