import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../index";
import { kvKeys, type AuthRecord } from "../kv/schema";

// Extend Hono Variables to carry authenticated userId
declare module "hono" {
  interface ContextVariableMap {
    authUserId: string | null; // null = no auth header (fallback mode)
  }
}

/** Routes that don't require authentication */
function isPublicRoute(method: string, path: string): boolean {
  // POST /api/family — create family
  if (method === "POST" && /^\/api\/family\/?$/.test(path)) return true;
  // POST /api/family/:id/join — join family
  if (method === "POST" && /^\/api\/family\/[^/]+\/join\/?$/.test(path)) return true;
  return false;
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

/**
 * Generate a new auth token for a user and store both directions in KV.
 * Returns the token string.
 */
export async function generateAuthToken(
  kv: KVNamespace,
  userId: string,
): Promise<string> {
  // Generate 64-char hex token (32 random bytes → 64 hex chars)
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authRecord: AuthRecord = {
    token,
    createdAt: new Date().toISOString(),
  };

  // Delete any existing token for this user first
  const existingAuth = await kv.get<AuthRecord>(kvKeys.auth(userId), "json");
  const deleteOps: Promise<void>[] = [];
  if (existingAuth?.token) {
    deleteOps.push(kv.delete(kvKeys.authToken(existingAuth.token)));
  }

  await Promise.all([
    ...deleteOps,
    kv.put(kvKeys.auth(userId), JSON.stringify(authRecord)),
    kv.put(kvKeys.authToken(token), userId),
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
