import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type RawFamilyRecord, normalizeFamilyRecord, type UserBooksRecord } from "../kv/schema";
import { isValidUserId } from "../utils/validation";
import { getAuthenticatedUserId, deleteAuthToken } from "../middleware/auth";

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

  // If authenticated, only allow access to own data
  const authUserId = getAuthenticatedUserId(c);
  if (authUserId && authUserId !== userId) {
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

  // If authenticated, only allow modifying own data
  const authUserId = getAuthenticatedUserId(c);
  if (authUserId && authUserId !== userId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Cannot modify another user's data" } },
      403,
    );
  }

  let body: { payload: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.payload || typeof body.payload !== "string") {
    return c.json(
      { error: { code: "INVALID_PAYLOAD", message: "payload is required" } },
      400,
    );
  }

  const record: UserBooksRecord = {
    payload: body.payload,
    lastUpdated: new Date().toISOString(),
  };

  await c.env.KV.put(kvKeys.user(userId), JSON.stringify(record));

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
        return c.json(
          { error: { code: "OWNER_CANNOT_DELETE", message: "管理者必須先轉移管理權才能移除帳戶" } },
          403,
        );
      }

      // Remove user from family members
      record.members = record.members.filter((m) => m.userId !== userId);
      await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
    }
  }

  // Delete all user data in parallel
  await Promise.all([
    c.env.KV.delete(kvKeys.user(userId)),
    c.env.KV.delete(kvKeys.member(userId)),
    deleteAuthToken(c.env.KV, userId),
  ]);

  return c.json({ data: { ok: true } });
});
