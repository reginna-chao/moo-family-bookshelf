import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type FamilyRecord } from "../kv/schema";

export const familyRoutes = new Hono<{ Bindings: Env }>();

// POST /api/family — create new family
familyRoutes.post("/", async (c) => {
  const familyId = generateFamilyId();
  const body = await c.req.json<{ userId: string }>().catch(() => null);

  if (!body?.userId) {
    return c.json(
      { error: { code: "MISSING_USER_ID", message: "userId is required" } },
      400,
    );
  }

  const record: FamilyRecord = {
    familyId,
    members: [body.userId],
    createdAt: new Date().toISOString(),
  };

  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
  await c.env.KV.put(kvKeys.member(body.userId), familyId);

  return c.json({ data: record }, 201);
});

// POST /api/family/:id/join
familyRoutes.post("/:id/join", async (c) => {
  const familyId = c.req.param("id");
  const body = await c.req.json<{ userId: string }>().catch(() => null);

  if (!body?.userId) {
    return c.json(
      { error: { code: "MISSING_USER_ID", message: "userId is required" } },
      400,
    );
  }

  const record = await c.env.KV.get<FamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!record) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  if (!record.members.includes(body.userId)) {
    record.members.push(body.userId);
    await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
  }

  await c.env.KV.put(kvKeys.member(body.userId), familyId);

  return c.json({ data: { ok: true } });
});

// DELETE /api/family/:id/member/:uid
familyRoutes.delete("/:id/member/:uid", async (c) => {
  const familyId = c.req.param("id");
  const userId = c.req.param("uid");

  const record = await c.env.KV.get<FamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!record) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  record.members = record.members.filter((m) => m !== userId);
  await c.env.KV.put(kvKeys.family(familyId), JSON.stringify(record));
  await c.env.KV.delete(kvKeys.member(userId));

  return c.json({ data: { ok: true } });
});

// GET /api/family/:id/members
familyRoutes.get("/:id/members", async (c) => {
  const familyId = c.req.param("id");
  const record = await c.env.KV.get<FamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!record) {
    return c.json(
      { error: { code: "FAMILY_NOT_FOUND", message: "Family not found" } },
      404,
    );
  }

  return c.json({ data: record });
});

function generateFamilyId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const segments = [4, 4].map(() => {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  });
  return segments.join("-");
}
