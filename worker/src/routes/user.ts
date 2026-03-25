import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type UserBooksRecord } from "../kv/schema";

export const userRoutes = new Hono<{ Bindings: Env }>();

// GET /api/user/:id/books
userRoutes.get("/:id/books", async (c) => {
  const userId = c.req.param("id");
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
  const body = await c.req.json<{ payload: string }>();

  if (!body.payload || typeof body.payload !== "string") {
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

  return c.json({ data: { ok: true } });
});
