import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../utils/env";
import {
  kvKeys,
  BoolFlag,
  type RawFamilyRecord,
  type UserBooksRecord,
  normalizeFamilyRecord,
} from "../kv/schema";
import { isValidFamilyId, sanitizeCoverUrl } from "../utils/validation";
import { getAuthenticatedUserId } from "../middleware/auth";
import { enforcePerUserRateLimit } from "../middleware/rateLimit";
import { defaultHook, jsonRes } from "../utils/openapi";
import { jsonError } from "../utils/errors";
import { FamilyIdParam } from "../schemas/common";

export const bookshelfRoutes = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook,
});

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
    429: jsonRes("Rate limit exceeded"),
  },
});

// --- Handler ---

// GET /api/family/:id/bookshelf
bookshelfRoutes.openapi(getFamilyBookshelfRoute, async (c) => {
  const familyId = c.req.param("id");

  if (!isValidFamilyId(familyId)) {
    return jsonError(
      c,
      400,
      "INVALID_FAMILY_ID",
      "Family ID format is invalid",
    );
  }

  // Verify caller is authenticated and a member of this family
  const userId = getAuthenticatedUserId(c);
  if (!userId) {
    return jsonError(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Per-userId rate limit: this is the most expensive endpoint (N KV reads,
  // one per family member). Layered on top of the per-IP limit to cap fan-out
  // cost from a single authenticated caller. Mirrors the borrow-list guard.
  const rateLimitResponse = await enforcePerUserRateLimit(c, {
    userId,
    scope: "bookshelf",
    max: 30,
    windowSec: 60,
  });
  if (rateLimitResponse) return rateLimitResponse;

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
      // Read-side twin of the buildSnapshot chokepoint — a dormant pre-whitelist
      // record must not beacon family members via the aggregation.
      const sharedBooks = (record?.books ?? [])
        .filter((b) => b.isShared === BoolFlag.TRUE)
        .map((b) => ({ ...b, coverUrl: sanitizeCoverUrl(b.coverUrl) }));
      return {
        userId: member.userId,
        displayName: member.displayName,
        books: sharedBooks,
        lastUpdated: record?.lastUpdated ?? null,
      };
    }),
  );

  return c.json(
    {
      data: {
        familyId,
        members: memberBooks,
      },
    },
    200,
  );
});
