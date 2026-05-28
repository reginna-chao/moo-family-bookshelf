import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import { kvKeys, type RawFamilyRecord, normalizeFamilyRecord, type UserBooksRecord, type PublicShelf, type BookEntry } from "../kv/schema";
import { writePublicSnapshot } from "./publicShelf";
import { isValidUserId, sanitizeDisplayName } from "../utils/validation";
import { getAuthenticatedUserId, deleteAuthToken } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { UserIdParam } from "../schemas/common";

async function updateAllPublicSnapshots(
  kv: KVNamespace,
  userId: string,
  shelves: PublicShelf[],
  books: BookEntry[],
): Promise<void> {
  if (shelves.length === 0) return;
  await Promise.all(
    shelves.map((shelf) => writePublicSnapshot(kv, userId, shelf, books)),
  );
}

/**
 * Resolve the authoritative displayName for a user when saving their book list.
 * - In a family: the family record is the source of truth (including empty,
 *   which represents a deliberate clear). Prevents stale client cache from
 *   overwriting the server value.
 * - Not in a family: sanitize the client-supplied value. Returns "" if invalid.
 */
async function resolveDisplayName(
  kv: KVNamespace,
  userId: string,
  memberFamilyId: string | null,
  clientValue: unknown,
): Promise<string> {
  if (memberFamilyId) {
    const familyRaw = await kv.get<RawFamilyRecord>(kvKeys.family(memberFamilyId), "json");
    if (familyRaw) {
      const self = normalizeFamilyRecord(familyRaw).members.find((m) => m.userId === userId);
      if (self) return self.displayName;
    }
  }
  return sanitizeDisplayName(clientValue) ?? "";
}

export const userRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

// GET /api/user/:id/books
const getUserBooksRoute = createRoute({
  method: "get",
  path: "/{id}/books",
  tags: ["User"],
  summary: "Get user books",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("User books record"),
    400: jsonRes("Invalid user ID"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
  },
});

userRoutes.openapi(getUserBooksRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }
  if (authUserId !== userId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Cannot access another user's data" } },
      403,
    );
  }

  const key = kvKeys.user(userId);
  const record = await c.env.KV.get<UserBooksRecord>(key, "json");

  if (!record) {
    return c.json({ data: null });
  }

  return c.json({ data: record });
});

// PUT /api/user/:id/books
const putUserBooksRoute = createRoute({
  method: "put",
  path: "/{id}/books",
  tags: ["User"],
  summary: "Save user books",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("Saved user books record"),
    400: jsonRes("Invalid request"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
    429: jsonRes("Rate limited"),
  },
});

userRoutes.openapi(putUserBooksRoute, async (c) => {
  const userId = c.req.param("id");

  if (!isValidUserId(userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const authUserId = getAuthenticatedUserId(c);
  if (!authUserId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }
  if (authUserId !== userId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Cannot modify another user's data" } },
      403,
    );
  }

  // Per-userId write rate limit: max 30 saves per userId per hour.
  // Layered on top of per-IP rate limit; prevents compromised-account abuse
  // from draining the daily 1000 KV write quota.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId: authUserId,
    scope: "put-books",
    max: 30,
    windowSec: 3600,
  });
  if (rateLimitResponse) // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rateLimitResponse as any;

  let body: Record<string, unknown> | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body || !Array.isArray(body.books)) {
    return c.json(
      { error: { code: "INVALID_PAYLOAD", message: "books array is required" } },
      400,
    );
  }

  // Read user record + family membership in parallel (independent reads).
  const [existing, memberFamilyId] = await Promise.all([
    c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json"),
    c.env.KV.get(kvKeys.member(userId)),
  ]);

  // Resolve displayName: family record is authoritative when the user is in a family
  // (even an empty value, which represents a deliberate clear). Only fall back to the
  // client-supplied value when there is no family membership / family record.
  const serverDisplayName = await resolveDisplayName(c.env.KV, userId, memberFamilyId, body.displayName);

  const record: UserBooksRecord = {
    ...body,
    books: body.books,
    schemaVersion: typeof body.schemaVersion === "number" ? body.schemaVersion : 1,
    userId: typeof body.userId === "string" ? body.userId : userId,
    displayName: serverDisplayName,
    lastUpdated: new Date().toISOString(),
    publicSharing: existing?.publicSharing,
  };

  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));

  // Update public shelf snapshots for all active shelves
  const shelves = record.publicSharing?.shelves ?? [];
  await updateAllPublicSnapshots(c.env.KV, userId, shelves, record.books);

  return c.json({ data: record });
});

// DELETE /api/user/:id — delete user account
const deleteUserRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["User"],
  summary: "Delete user account",
  request: {
    params: UserIdParam,
  },
  responses: {
    200: jsonRes("User deleted"),
    400: jsonRes("Invalid user ID"),
    401: jsonRes("Unauthorized"),
    403: jsonRes("Forbidden"),
  },
});

userRoutes.openapi(deleteUserRoute, async (c) => {
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
      { error: { code: "FORBIDDEN", message: "Cannot delete another user's account" } },
      403,
    );
  }

  // Check family membership
  const familyId = await c.env.KV.get(kvKeys.member(userId));

  if (familyId) {
    const raw = await c.env.KV.get<RawFamilyRecord>(
      kvKeys.family(familyId),
      "json",
    );

    if (raw) {
      const record = normalizeFamilyRecord(raw);

      if (record.ownerId === userId) {
        if (record.members.length > 1) {
          return c.json(
            { error: { code: "OWNER_CANNOT_DELETE", message: "管理者必須先轉移管理權才能移除帳戶" } },
            403,
          );
        }

        // Single-member owner: delete entire family record
        await c.env.KV.delete(kvKeys.family(familyId));
      } else {
        // Remove user from family members
        record.members = record.members.filter((m) => m.userId !== userId);
        await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
      }
    }
  }

  // Collect public shelf tokens for cleanup
  const userRecord = await c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json");
  const publicTokens = userRecord?.publicSharing?.shelves?.map((s) => s.shareToken) ?? [];

  // Delete all user data in parallel
  await Promise.all([
    c.env.KV.delete(kvKeys.user(userId)),
    c.env.KV.delete(kvKeys.member(userId)),
    deleteAuthToken(c.env.KV, userId),
    ...publicTokens.map((token) => c.env.KV.delete(kvKeys.publicShelf(token))),
  ]);

  return c.json({ data: { ok: true } });
});
