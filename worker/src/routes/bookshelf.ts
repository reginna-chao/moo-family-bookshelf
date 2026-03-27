import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type RawFamilyRecord, type UserBooksRecord, normalizeFamilyRecord } from "../kv/schema";

export const bookshelfRoutes = new Hono<{ Bindings: Env }>();

// GET /api/family/:id/bookshelf
bookshelfRoutes.get("/family/:id/bookshelf", async (c) => {
  const familyId = c.req.param("id");

  // Get family members
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

  const family = normalizeFamilyRecord(raw);

  // Fetch all members' book data in parallel
  const memberBooks = await Promise.all(
    family.members.map(async (userId) => {
      const books = await c.env.KV.get<UserBooksRecord>(
        kvKeys.user(userId),
        "json",
      );
      return {
        userId,
        payload: books?.payload ?? null,
        lastUpdated: books?.lastUpdated ?? null,
      };
    }),
  );

  return c.json({
    data: {
      familyId,
      members: memberBooks,
    },
  });
});
