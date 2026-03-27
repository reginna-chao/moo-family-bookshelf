import { Hono } from "hono";
import type { Env } from "../index";
import { kvKeys, type RawFamilyRecord, type UserBooksRecord, normalizeFamilyRecord } from "../kv/schema";
import { isValidFamilyId } from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";

export const bookshelfRoutes = new Hono<{ Bindings: Env }>();

// GET /api/family/:id/bookshelf
bookshelfRoutes.get("/family/:id/bookshelf", async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return c.json(
      { error: { code: "INVALID_FAMILY_ID", message: "Family ID format is invalid" } },
      400,
    );
  }

  // Verify caller is authenticated and a member of this family
  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401,
    );
  }

  const memberFamily = await c.env.KV.get(kvKeys.member(userId));
  if (memberFamily !== familyId) {
    return c.json(
      { error: { code: "FORBIDDEN", message: "Not a family member" } },
      403,
    );
  }

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
