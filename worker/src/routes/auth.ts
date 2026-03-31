import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, TOKEN_TTL_SECONDS } from "../kv/schema";
import { isValidFamilyId } from "../utils/validation";
import { getOrGenerateAuthToken } from "../middleware/auth";

export const authRoutes = new Hono<{ Bindings: Env }>();

/** Validate 64-char lowercase hex string (SHA-256 output). */
function isValidSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * Convert ArrayBuffer to hex string.
 */
function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// POST /api/auth/hash — derive userId from email (public, no auth required)
authRoutes.post("/hash", async (c) => {
  let body: { email: string } | null;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      400,
    );
  }

  if (!body?.email || typeof body.email !== "string") {
    return c.json(
      { error: { code: "MISSING_EMAIL", message: "email is required" } },
      400,
    );
  }

  const trimmed = body.email.trim();
  if (trimmed.length === 0) {
    return c.json(
      { error: { code: "MISSING_EMAIL", message: "email must not be empty" } },
      400,
    );
  }

  const normalized = trimmed.toLowerCase();
  const encoded = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const userId = bufferToHex(hash);

  return c.json({ data: { userId } });
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
