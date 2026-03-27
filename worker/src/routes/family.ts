import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type RawFamilyRecord, normalizeFamilyRecord } from "../kv/schema";
import { isValidUserId, isValidFamilyId } from "../utils/validation";
import { generateAuthToken, deleteAuthToken, getAuthenticatedUserId } from "../middleware/auth";

// Business logic is kept inline for simplicity; extract to services/ if handlers grow further

export const familyRoutes = new Hono<{ Bindings: Env }>();

// POST /api/family — create new family
familyRoutes.post("/", async (c) => {
  const familyId = generateFamilyId();

  let body: { userId: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.userId) {
    return c.json(
      { error: { code: "MISSING_USER_ID", message: "userId is required" } },
      400,
    );
  }

  if (!isValidUserId(body.userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const record = {
    familyId,
    ownerId: body.userId,
    members: [body.userId],
    maxMembers: 2,
    createdAt: new Date().toISOString(),
  };

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.put(kvKeys.member(body.userId), familyId),
  ]);

  const authToken = await generateAuthToken(c.env.KV, body.userId);

  return c.json({ data: { ...record, authToken } }, 201);
});

// POST /api/family/:id/join
familyRoutes.post("/:id/join", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  let body: { userId: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.userId) {
    return c.json(
      { error: { code: "MISSING_USER_ID", message: "userId is required" } },
      400,
    );
  }

  if (!isValidUserId(body.userId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  // Finding #5: Check if user already belongs to a different family
  const existingFamily = await c.env.KV.get(kvKeys.member(body.userId));
  if (existingFamily && existingFamily !== familyId) {
    return c.json(
      { error: { code: "ALREADY_IN_FAMILY", message: "請先離開目前的家庭再加入新家庭" } },
      409,
    );
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  if (!record.members.includes(body.userId)) {
    // NOTE: No atomic compare-and-swap in KV. Concurrent joins could bypass
    // maxMembers limit. Acceptable for 2-person families with low concurrency.
    if (record.members.length >= record.maxMembers) {
      return c.json(
        { error: { code: "FAMILY_FULL", message: "家庭成員已達上限" } },
        409,
      );
    }
    record.members.push(body.userId);
  }

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.put(kvKeys.member(body.userId), familyId),
  ]);

  const authToken = await generateAuthToken(c.env.KV, body.userId);

  return c.json({ data: { ...record, authToken } });
});

// DELETE /api/family/:id/member/:uid
familyRoutes.delete("/:id/member/:uid", async (c) => {
  const familyId = c.req.param("id");
  const targetUserId = c.req.param("uid");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  const fallbackCallerId = c.req.query("userId");
  const callerId = getAuthenticatedUserId(c, fallbackCallerId ?? undefined);

  if (!callerId) {
    return c.json(
      { error: { code: "MISSING_USER_ID", message: "userId query parameter is required" } },
      400,
    );
  }

  if (!isValidUserId(callerId) || !isValidUserId(targetUserId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  // Owner cannot leave (must transfer first)
  if (callerId === record.ownerId && targetUserId === callerId) {
    return c.json(
      { error: { code: "OWNER_CANNOT_LEAVE", message: "請先轉移管理權後再離開" } },
      403,
    );
  }

  // Non-owner cannot remove others
  if (callerId !== record.ownerId && targetUserId !== callerId) {
    return c.json(
      { error: { code: "NOT_OWNER", message: "只有管理者可以移除其他成員" } },
      403,
    );
  }

  // Finding #6: Check if target is actually a member
  if (!record.members.includes(targetUserId)) {
    return c.json(
      { error: { code: "MEMBER_NOT_FOUND", message: "目標使用者不是家庭成員" } },
      404,
    );
  }

  record.members = record.members.filter((m) => m !== targetUserId);

  await Promise.all([
    c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record)),
    c.env.KV.delete(kvKeys.member(targetUserId)),
    deleteAuthToken(c.env.KV, targetUserId),
  ]);

  return c.json({ data: record });
});

// GET /api/family/:id/members
familyRoutes.get("/:id/members", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  // If authenticated, verify family membership
  const userId = getAuthenticatedUserId(c);
  if (userId) {
    const memberFamily = await c.env.KV.get(kvKeys.member(userId));
    if (memberFamily !== familyId) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Not a family member" } },
        403,
      );
    }
  }
  // If no auth (fallback mode), allow access (backward compat)

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  return c.json({ data: record });
});

// PUT /api/family/:id/transfer — transfer ownership
familyRoutes.put("/:id/transfer", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  let body: { userId: string; newOwnerId: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.userId || !body?.newOwnerId) {
    return c.json(
      { error: { code: "MISSING_FIELDS", message: "userId and newOwnerId are required" } },
      400,
    );
  }

  if (!isValidUserId(body.userId) || !isValidUserId(body.newOwnerId)) {
    return c.json(
      { error: { code: "INVALID_USER_ID", message: "userId format is invalid" } },
      400,
    );
  }

  const callerUserId = getAuthenticatedUserId(c, body.userId);

  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  const record = normalizeFamilyRecord(raw);

  if (callerUserId !== record.ownerId) {
    return c.json(
      { error: { code: "NOT_OWNER", message: "只有管理者可以轉移管理權" } },
      403,
    );
  }

  if (body.newOwnerId === body.userId) {
    return c.json(
      { error: { code: "SAME_OWNER", message: "不能轉移給自己" } },
      400,
    );
  }

  if (!record.members.includes(body.newOwnerId)) {
    return c.json(
      { error: { code: "INVALID_MEMBER", message: "目標使用者不是家庭成員" } },
      400,
    );
  }

  record.ownerId = body.newOwnerId;
  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));

  return c.json({ data: record });
});

function generateFamilyId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const segments = [0, 4].map((start) => {
    let s = "";
    for (let i = start; i < start + 4; i++) {
      s += chars[bytes[i] % chars.length];
    }
    return s;
  });
  return segments.join("-");
}
