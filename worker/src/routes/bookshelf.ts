import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import { kvKeys, type RawFamilyRecord, type UserBooksRecord, normalizeFamilyRecord } from "../kv/schema";
import { isValidFamilyId } from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { FamilyIdParam } from "../schemas/common";

export const bookshelfRoutes = new OpenAPIHono<{ Bindings: Env }>({ defaultHook });

// --- Route definition ---

const getFamilyBookshelfRoute = createRoute({
  method: "get",
  path: "/family/{id}/bookshelf",
  tags: ["Bookshelf"],
  summary: "Get aggregated family bookshelf",
  request: {
    params: FamilyIdParam,
  },
  responses: {
    200: jsonRes("Aggregated family bookshelf"),
    400: jsonRes("Invalid family ID"),
    401: jsonRes("Unauthorized"),
    404: jsonRes("Family not found"),
  },
});

// --- Handler ---

// GET /api/family/:id/bookshelf
bookshelfRoutes.openapi(getFamilyBookshelfRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(c, 400, "INVALID_FAMILY_ID", "Family ID format is invalid");
  }

  // Verify caller is authenticated and a member of this family
  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  const memberFamily = await c.env.KV.get(kvKeys.member(userId));
  if (memberFamily !== familyId) {
    return jsonError(c, 404, "NOT_FOUND", "Family not found");
  }

  // Get family members
  const raw = await c.env.KV.get<RawFamilyRecord>(
    kvKeys.family(familyId),
    "json",
  );

  if (!raw) {
    return jsonError(c, 404, "FAMILY_NOT_FOUND", "Family not found");
  }

  const family = normalizeFamilyRecord(raw);

  // Fetch all members' book data in parallel
  const memberBooks = await Promise.all(
    family.members.map(async (member) => {
      const record = await c.env.KV.get<UserBooksRecord>(
        kvKeys.user(member.userId),
        "json",
      );
      const sharedBooks = (record?.books ?? []).filter((b) => b.isShared === 1);
      return {
        userId: member.userId,
        displayName: member.displayName,
        books: sharedBooks,
        lastUpdated: record?.lastUpdated ?? null,
      };
    }),
  );

  return c.json({
    data: {
      familyId,
      members: memberBooks,
    },
  }, 200);
});
