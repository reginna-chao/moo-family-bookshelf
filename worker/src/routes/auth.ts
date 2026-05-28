import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import { kvKeys, TOKEN_TTL_SECONDS, type RawFamilyRecord, normalizeFamilyRecord } from "../kv/schema";
import { isValidFamilyId, isValidSha256Hex } from "../utils/validation";
import { getOrGenerateAuthToken, getAuthenticatedUserId } from "../middleware/auth";
import { defaultHook, jsonRes } from "../utils/openapi";

export const authRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

// --- Route definitions ---

const lookupRoute = createRoute({
  method: "post",
  path: "/lookup",
  tags: ["Auth"],
  summary: "Look up family membership by userId",
  responses: {
    200: jsonRes("Family membership lookup result"),
    400: jsonRes("Invalid input"),
  },
});

const refreshRoute = createRoute({
  method: "post",
  path: "/refresh",
  tags: ["Auth"],
  summary: "Refresh auth token",
  responses: {
    200: jsonRes("New auth token"),
    400: jsonRes("Invalid input"),
    401: jsonRes("Unauthorized or refresh failed"),
  },
});

// --- Handlers ---

// POST /api/auth/lookup — look up family membership by userId (public, no auth required)
authRoutes.openapi(lookupRoute, async (c) => {
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

  return c.json({ data: { existingFamilyId, memberCount } }, 200);
});

// POST /api/auth/refresh — refresh auth token (protected: requires valid Bearer token)
authRoutes.openapi(refreshRoute, async (c) => {
  const callerId = getAuthenticatedUserId(c);
  if (!callerId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  let body: { userId: string; familyId?: string } | null;
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

  // Ensure the authenticated user matches the requested userId
  if (callerId !== body.userId) {
    return c.json(
      { error: { code: "REFRESH_FAILED", message: "Token refresh failed" } },
      401,
    );
  }

  // If familyId is provided, verify membership (backward-compatible path)
  if (body.familyId !== undefined) {
    if (typeof body.familyId !== "string" || !isValidFamilyId(body.familyId)) {
      return c.json(
        { error: { code: "INVALID_INPUT", message: "familyId must match format xxxx-xxxx" } },
        400,
      );
    }
    const storedFamilyId = await c.env.KV.get(kvKeys.member(body.userId));
    if (!storedFamilyId || storedFamilyId !== body.familyId) {
      return c.json(
        { error: { code: "REFRESH_FAILED", message: "Token refresh failed" } },
        401,
      );
    }
  }

  const newToken = await getOrGenerateAuthToken(c.env.KV, body.userId);
  const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;

  return c.json({ data: { token: newToken, expiresAt } }, 200);
});
