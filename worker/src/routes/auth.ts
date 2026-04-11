import { Hono } from "hono";
import type { Env } from "../utils/env";
import { kvKeys, TOKEN_TTL_SECONDS, type RawFamilyRecord, normalizeFamilyRecord } from "../kv/schema";
import { isValidFamilyId, isValidSha256Hex } from "../utils/validation";
import { getOrGenerateAuthToken, getAuthenticatedUserId } from "../middleware/auth";

export const authRoutes = new Hono<{ Bindings: Env }>();

// POST /api/auth/lookup — look up family membership by userId (public, no auth required)
authRoutes.post("/lookup", async (c) => {
  let body: { userId: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.userId || typeof body.userId !== "string" || !isValidSha256Hex(body.userId)) {
    return c.json(
      { error: { code: "INVALID_INPUT", message: "userId must be a 64-char hex string" } },
      400,
    );
  }

  const userId = body.userId;

  // Look up family membership
  let existingFamilyId: string | null = null;
  let memberCount = 0;

  const familyId = await c.env.KV.get(kvKeys.member(userId));
  if (familyId) {
    existingFamilyId = familyId;
    const raw = await c.env.KV.get<RawFamilyRecord>(kvKeys.family(familyId), "json");
    if (raw) {
      const record = normalizeFamilyRecord(raw);
      memberCount = record.members.length;
    }
  }

  return c.json({ data: { existingFamilyId, memberCount } });
});

// POST /api/auth/refresh — refresh auth token (protected: requires valid Bearer token)
authRoutes.post("/refresh", async (c) => {
  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  let body: { userId: string; familyId: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  // Validate input format
  if (
    !body?.userId ||
    typeof body.userId !== "string" ||
    !isValidSha256Hex(body.userId)
  ) {
    return c.json(
      { error: { code: "INVALID_INPUT", message: "userId must be a 64-char hex string" } },
      400,
    );
  }

  if (
    !body?.familyId ||
    typeof body.familyId !== "string" ||
    !isValidFamilyId(body.familyId)
  ) {
    return c.json(
      { error: { code: "INVALID_INPUT", message: "familyId must match format xxxx-xxxx" } },
      400,
    );
  }

  // Ensure the authenticated user matches the requested userId
  if (callerId !== body.userId) {
    return c.json(
      { error: { code: "REFRESH_FAILED", message: "Token refresh failed" } },
      401,
    );
  }

  // Verify user is a member of the requested family
  const storedFamilyId = await c.env.KV.get(kvKeys.member(body.userId));
  if (!storedFamilyId || storedFamilyId !== body.familyId) {
    return c.json(
      { error: { code: "REFRESH_FAILED", message: "Token refresh failed" } },
      401,
    );
  }

  const newToken = await getOrGenerateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { token: newToken, expiresAt } });
});
