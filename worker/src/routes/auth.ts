import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type AuthRecord } from "../kv/schema";

export const authRoutes = new Hono<{ Bindings: Env }>();

/** Validate 64-char lowercase hex string (SHA-256 output). */
function isValidSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/** Token TTL: 90 days in seconds */
const TOKEN_TTL_SECONDS = 7776000;

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

// POST /api/auth/refresh — refresh auth token (public, no auth required)
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
    body.familyId.trim().length === 0
  ) {
    return c.json(
      { error: { code: "INVALID_INPUT", message: "familyId is required" } },
      400,
    );
  }

  // Verify user is a member of the requested family
  const storedFamilyId = await c.env.KV.get(kvKeys.member(body.userId));
  if (!storedFamilyId || storedFamilyId !== body.familyId) {
    return c.json(
      { error: { code: "NOT_FAMILY_MEMBER", message: "User is not a member of this family" } },
      403,
    );
  }

  // Delete old token if exists
  const existingAuth = await c.env.KV.get<AuthRecord>(kvKeys.auth(body.userId), "json");
  if (existingAuth?.token) {
    await c.env.KV.delete(kvKeys.authToken(existingAuth.token));
  }

  // Generate new 32-byte random token (64 hex chars)
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const newToken = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authRecord: AuthRecord = {
    token: newToken,
    createdAt: new Date().toISOString(),
  };

  // Store bidirectional entries with 90-day TTL
  await Promise.all([
    c.env.KV.put(kvKeys.auth(body.userId), JSON.stringify(authRecord), {
      expirationTtl: TOKEN_TTL_SECONDS,
    }),
    c.env.KV.put(kvKeys.authToken(newToken), body.userId, {
      expirationTtl: TOKEN_TTL_SECONDS,
    }),
  ]);

  return c.json({ data: { token: newToken } });
});
