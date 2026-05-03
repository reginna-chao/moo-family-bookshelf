import { Hono } from "hono";
import type { Env } from "../utils/env";
import { kvKeys, type RawFamilyRecord, normalizeFamilyRecord, type UserBooksRecord, type PublicShelf, type BookEntry } from "../kv/schema";
import { writePublicSnapshot } from "./publicShelf";
import { isValidUserId } from "../utils/validation";
import { getAuthenticatedUserId, deleteAuthToken } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";

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

export const userRoutes = new Hono<{ Bindings: Env }>();

// GET /api/user/:id/books
userRoutes.get("/:id/books", async (c) => {
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
userRoutes.put("/:id/books", async (c) => {
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
  if (rateLimitResponse) return rateLimitResponse;

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

  // Read existing record to preserve server-managed fields (publicSharing)
  const existing = await c.env.KV.get<UserBooksRecord>(kvKeys.user(userId), "json");

  const record: UserBooksRecord = {
    ...body,
    books: body.books,
    schemaVersion: typeof body.schemaVersion === "number" ? body.schemaVersion : 1,
    userId: typeof body.userId === "string" ? body.userId : userId,
    displayName: typeof body.displayName === "string" ? body.displayName : "",
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
userRoutes.delete("/:id", async (c) => {
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
