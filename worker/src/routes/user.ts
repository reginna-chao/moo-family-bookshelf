import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type UserBooksRecord } from "../kv/schema";
import { isValidUserId } from "../utils/validation";

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
