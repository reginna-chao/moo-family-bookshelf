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

/**
 * Auth middleware: checks Authorization header.
 * If present, validates Bearer token against KV.
 * If absent, sets authUserId = null (fallback mode for backward compat).
 */
export const authMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      c.set("authUserId", null);
      await next();
      return;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (!match) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } },
        401,
      );
    }

    const token = match[1];
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
 * Returns the authenticated userId from context if available,
 * otherwise returns the fallback userId. Returns null if neither exists.
 */
export function getAuthenticatedUserId(
  c: Context,
  fallbackUserId?: string,
): string | null {
  const authUserId = c.get("authUserId") as string | null;
  if (authUserId) return authUserId;
  return fallbackUserId ?? null;
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
