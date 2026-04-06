import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, TOKEN_TTL_SECONDS, type RawFamilyRecord, normalizeFamilyRecord } from "../kv/schema";
import { isValidFamilyId } from "../utils/validation";
import { getOrGenerateAuthToken } from "../middleware/auth";

export const authRoutes = new Hono<{ Bindings: Env }>();

/** Validate 64-char lowercase hex string (SHA-256 output). */
function isValidSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

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

// POST /api/auth/refresh — refresh auth token (public route, uses membership as auth)
authRoutes.post("/refresh", async (c) => {
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

  // Verify user is a member of the requested family
  // Return generic 401 (not 403) to avoid leaking membership info
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
