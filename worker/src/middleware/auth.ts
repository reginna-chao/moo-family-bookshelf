import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import {
  getAccountDeletedMark,
  getAuthTokenRecord,
  getRawAuthRecord,
} from "../kv/auth";
import { getUserBooksRecord } from "../kv/users";
import { HEX_64 } from "../services/authRecord";
import { accountDeleteTargetUserId, isPublicRoute } from "../utils/routes";
import { jsonError } from "../utils/errors";
import { hashAuthToken } from "../utils/crypto";
import { ACCOUNT_DELETED_ERROR_CODE } from "moo-family-bookshelf-shared/api/accountDeleted";

// Extend Hono Variables to carry authenticated userId
declare module "hono" {
  interface ContextVariableMap {
    authUserId: string | null; // null = no auth header (fallback mode)
  }
}

/** The 64-char hex token of a `Bearer <token>` header, or `null` when the header is absent or malformed. */
function parseBearerToken(authHeader: string | undefined): string | null {
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  if (!match || !HEX_64.test(match[1])) return null;
  return match[1];
}

/** userId of a bearer from `token:{hash}`; `null` when absent or malformed. */
async function resolveTokenUserId(
  kv: KVNamespace,
  tokenHash: string,
): Promise<string | null> {
  const record = await getAuthTokenRecord(kv, tokenHash);
  if (record === null) return null;
  const userId: unknown = record.userId;
  return typeof userId === "string" && userId !== "" ? userId : null;
}

/** A dead bearer retrying the deletion it already finished (#462); only `DELETE /api/user/:id` pays for these reads.
 *  `auth:` alone proves nothing: leave and kick delete it too and a leave keeps `user:`, so both must be absent. */
async function isDeletedAccountBearer(
  kv: KVNamespace,
  method: string,
  path: string,
  tokenHash: string,
): Promise<boolean> {
  const target = accountDeleteTargetUserId(method, path);
  if (target === null) return false;
  if ((await getAccountDeletedMark(kv, tokenHash)) !== target) return false;
  const [auth, books] = await Promise.all([
    getRawAuthRecord(kv, target),
    getUserBooksRecord(kv, target),
  ]);
  return auth === null && books === null;
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

    const tokenHash = await hashAuthToken(token);
    const userId = await resolveTokenUserId(c.env.KV, tokenHash);
    if (!userId) {
      const deleted = await isDeletedAccountBearer(
        c.env.KV,
        c.req.method,
        c.req.path,
        tokenHash,
      );
      return deleted
        ? jsonError(c, 401, ACCOUNT_DELETED_ERROR_CODE, "這個帳戶已經移除")
        : jsonError(c, 401, "UNAUTHORIZED", "Invalid or expired token");
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
