import { Hono } from "hono";
import type { Env } from "../index";

export const authRoutes = new Hono<{ Bindings: Env }>();

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
